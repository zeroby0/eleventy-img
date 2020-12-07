// TODO use `srcsethelp` project to improve output (blurry lowsrc?)

const path = require("path");
const fs = require("fs-extra");
const { URL } = require("url");

const shorthash = require("short-hash");
const {default: PQueue} = require("p-queue");
const imageSize = require("image-size");
const sharp = require("sharp");
const debug = require("debug")("EleventyImg");

const avifHook = require("./format-hooks/avif");

const CacheAsset = require("@11ty/eleventy-cache-assets");

const globalOptions = {
  src: null,
  widths: [null],
  formats: ["webp", "jpeg"], // "png", "svg"
  concurrency: 10,
  urlPath: "/img/",
  outputDir: "img/",
  svgShortCircuit: false, // skip raster formats if SVG input is found
  svgAllowUpscale: true,
  // overrideInputFormat: false, // internal, used to force svg output in statsSync et al
  sharpOptions: {}, // options passed to the Sharp constructor
  sharpWebpOptions: {}, // options passed to the Sharp webp output method
  sharpPngOptions: {}, // options passed to the Sharp png output method
  sharpJpegOptions: {}, // options passed to the Sharp jpeg output method
  extensions: {},
  formatHooks: {
    avif: avifHook
  },
  cacheDuration: "1d", // deprecated, use cacheOptions.duration
  cacheOptions: {
    // duration: "1d",
    // directory: ".cache",
    // removeUrlQueryParams: false,
    // fetchOptions: {},
  },
  filenameFormat: function (id, src, width, format, options) {
    if (width) {
      return `${id}-${width}.${format}`;
    }

    return `${id}.${format}`;
  },
};

const MIME_TYPES = {
  "jpeg": "image/jpeg",
  "webp": "image/webp",
  "png": "image/png",
  "svg": "image/svg+xml",
  "avif": "image/avif",
};

function getFormatsArray(formats) {
  if(formats && formats.length) {
    if(typeof formats === "string") {
      formats = formats.split(",");
    }

    // svg must come first for possible short circuiting
    formats.sort((a, b) => {
      if(a === "svg") {
        return -1;
      } else if(b === "svg") {
        return 1;
      }
      return 0;
    });

    return formats;
  }

  return [];
}

function getValidWidths(originalWidth, widths = [], allowUpscale = false) {
  let valid = widths.map(width => width ? width : originalWidth);
  let filtered = valid.filter(width => allowUpscale || width <= originalWidth);
  // if the only valid width was larger than the original (and no upscaling), then use the original width
  if(valid.length > 0 && filtered.length === 0) {
    filtered.push(originalWidth);
  }
  return filtered.sort((a, b) => a - b);
}

function getFilename(src, width, format, options = {}) {
  let id = shorthash(src);
  if (typeof options.filenameFormat === 'function') {
    let filename = options.filenameFormat(id, src, width, format, options);
    // if options.filenameFormat returns falsy, use fallback filename
    if(filename) {
      return filename;
    }
  }

  if (width) {
    return `${id}-${width}.${format}`;
  }

  return `${id}.${format}`;
}

function getStats(src, format, urlPath, width, height, includeWidthInFilename, options = {}) {
  let outputExtension = options.extensions[format] || format;
  let outputFilename = getFilename(src, includeWidthInFilename ? width : false, outputExtension, options);
  let url = path.join(urlPath, outputFilename);

  return {
    format: format,
    width: width,
    height: height,
    filename: outputFilename,
    outputPath: path.join(options.outputDir, outputFilename),
    url: url,
    sourceType: MIME_TYPES[format],
    srcset: `${url} ${width}w`,
    // size // only after processing
  };
}

function getFilesize(path) {
  // reading from the local file system
  let fsStats = fs.statSync(path);
  return fsStats.size;
}

// metadata so far: width, height, format
function getFullStats(src, metadata, opts) {
  let options = Object.assign({}, globalOptions, opts);

  let results = [];
  let outputFormats = getFormatsArray(options.formats);

  for(let outputFormat of outputFormats) {
    if(!outputFormat) {
      outputFormat = metadata.format || options.overrideInputFormat;
    }
    if(!outputFormat) {
      throw new Error("When using statsSync or statsByDimensionsSync, `formats: [null]` to use the native image format is not supported.");
    }

    if(outputFormat === "svg") {
      if((metadata.format || options.overrideInputFormat) === "svg") {
        let svgStats = getStats(src, "svg", options.urlPath, metadata.width, metadata.height, false, options);
        // metadata.size is only available with Buffer input (remote urls)
        // Warning this is unfair for comparison because its uncompressed (no GZIP, etc)
        if(metadata.size) {
          svgStats.size = metadata.size;
        } else {
          // reading from the local file system as fallback
          svgStats.size = getFilesize(src);
        }
        results.push(svgStats);

        if(options.svgShortCircuit) {
          break;
        } else {
          continue;
        }
      } else {
        debug("Skipping: %o asked for SVG output but received raster input.", src);
        continue;
      }
    } else { // not SVG
      let hasAtLeastOneValidMaxWidth = false;
      let widths = getValidWidths(metadata.width, options.widths, metadata.format === "svg" && options.svgAllowUpscale);
      for(let width of widths) {
        let height;
        if(width === metadata.width) {
          height = metadata.height;
        } else {
          height = Math.floor(width * metadata.height / metadata.width);
        }

        let includeWidthInFilename = widths.length > 1 && width !== metadata.width;
        results.push(getStats(src, outputFormat, options.urlPath, width, height, includeWidthInFilename, options));
      }
    }
  }

  return transformRawFiles(results, outputFormats);
}

function transformRawFiles(files = [], formats = []) {
  let byType = {};
  for(let format of formats) {
    byType[format] = [];
  }
  for(let file of files) {
    if(!byType[file.format]) {
      byType[file.format] = [];
    }
    byType[file.format].push(file);
  }
  for(let type in byType) {
    // sort by width, ascending (for `srcset`)
    byType[type].sort((a, b) => {
      return a.width - b.width;
    });
  }
  return byType;
}

function getSharpOptionsForFormat(format, options) {
  if(format === "webp") {
    return options.sharpWebpOptions;
  } else if(format === "jpeg") {
    return options.sharpJpegOptions;
  } else if(format === "png") {
    return options.sharpPngOptions;
  }
  return {};
}

// src should be a file path to an image or a buffer
async function resizeImage(src, options = {}) {
  let sharpImage = sharp(src, Object.assign({
    failOnError: false
  }, options.sharpOptions));

  if(typeof src !== "string") {
    if(options.sourceUrl) {
      src = options.sourceUrl;
    } else {
      throw new Error("Expected options.sourceUrl in resizeImage when using Buffer as input.");
    }
  }

  // Must find the image format from the metadata
  // File extensions lie or may not be present in the src url!
  let metadata = await sharpImage.metadata();
  let outputFilePromises = [];

  let fullStats = getFullStats(src, metadata, options);
  for(let outputFormat in fullStats) {
    for(let stat of fullStats[outputFormat]) {
      if(outputFormat === "svg") {
        let sharpInput = sharpImage.options.input;
        let svgBuffer = sharpInput.buffer;
        if(!svgBuffer) { // local file system
          outputFilePromises.push(fs.copyFile(sharpInput.file, stat.outputPath).then(() => stat));
        } else {
          outputFilePromises.push(fs.writeFile(stat.outputPath, svgBuffer.toString("utf-8"), {
            encoding: "utf8"
          }).then(() => stat));
        }
      } else { // not SVG
        let sharpInstance = sharpImage.clone();
        if(stat.width < metadata.width || (options.svgAllowUpscale && metadata.format === "svg")) {
          let resizeOptions = {
            width: stat.width
          };
          if(metadata.format !== "svg" || !options.svgAllowUpscale) {
            resizeOptions.withoutEnlargement = true;
          }
          sharpInstance.resize(resizeOptions);
        }

        if(options.formatHooks && options.formatHooks[outputFormat]) {
          // custom format hook
          let hookResult = await options.formatHooks[outputFormat](sharpInstance);
          outputFilePromises.push(fs.writeFile(stat.outputPath, hookResult).then(data => {
            stat.size = hookResult.length;
            return stat;
          }));
        } else {
          if(outputFormat && metadata.format !== outputFormat) {
            let sharpFormatOptions = getSharpOptionsForFormat(outputFormat, options);
            sharpInstance.toFormat(outputFormat, sharpFormatOptions);
          }

          outputFilePromises.push(sharpInstance.toFile(stat.outputPath).then(data => {
            stat.size = data.size;
            return stat;
          }));
        }
      }
      debug( "Wrote %o", stat.outputPath );
    }
  }

  return Promise.all(outputFilePromises).then(files => transformRawFiles(files, Object.keys(fullStats)));
}

function isFullUrl(url) {
  try {
    new URL(url);
    return true;
  } catch(e) {
    // invalid url OR local path
    return false;
  }
}

/* Combine it all together */
async function image(src, opts) {
  if(!src) {
    throw new Error("`src` is a required argument to the eleventy-img utility (can be a string file path, string URL, or buffer).");
  }

  if(typeof src === "string" && isFullUrl(src)) {
    // fetch remote image
    let buffer = await CacheAsset(src, Object.assign({
      duration: opts.cacheDuration,
      type: "buffer"
    }, opts.cacheOptions));

    opts.sourceUrl = src;
    return resizeImage(buffer, opts);
  }

  // use file path to local image
  return resizeImage(src, opts);
}

/* Queue */
let queue = new PQueue({
  concurrency: globalOptions.concurrency
});
queue.on("active", () => {
  debug( `Concurrency: ${queue.concurrency}, Size: ${queue.size}, Pending: ${queue.pending}` );
});

async function queueImage(src, opts) {
  let options = Object.assign({}, globalOptions, opts);

  // create the output dir
  await fs.ensureDir(options.outputDir);

  return queue.add(() => image(src, options));
}

module.exports = queueImage;

Object.defineProperty(module.exports, "concurrency", {
  get: function() {
    return queue.concurrency;
  },
  set: function(concurrency) {
    queue.concurrency = concurrency;
  },
});

/* `statsSync` doesn’t generate any files, but will tell you where
 * the asynchronously generated files will end up! This is useful
 * in synchronous-only template environments where you need the
 * image URLs synchronously but can’t rely on the files being in
 * the correct location yet.
 */
function statsSync(src, opts) {
  let dimensions = imageSize(src);
  return getFullStats(src, dimensions, opts);
}

function statsByDimensionsSync(src, width, height, opts) {
  let dimensions = { width, height };
  return getFullStats(src, dimensions, opts);
}

module.exports.statsSync = statsSync;
module.exports.statsByDimensionsSync = statsByDimensionsSync;
module.exports.getFormats = getFormatsArray;
module.exports.getWidths = getValidWidths;
