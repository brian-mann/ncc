const resolve = require("resolve");
const fs = require("graceful-fs");
const crypto = require("crypto");
const { sep, dirname } = require("path");
const webpack = require("webpack");
const MemoryFS = require("memory-fs");
const terser = require("terser");
const tsconfigPaths = require("tsconfig-paths");
const TsconfigPathsPlugin = require("tsconfig-paths-webpack-plugin");
const shebangRegEx = require('./utils/shebang');
const { pkgNameRegEx } = require("./utils/get-package-base");
const nccCacheDir = require("./utils/ncc-cache-dir");

// support glob graceful-fs
fs.gracefulify(require("fs"));

const nodeBuiltins = new Set([...require("repl")._builtinLibs, "constants", "module", "timers", "console", "_stream_writable", "_stream_readable", "_stream_duplex"]);

const SUPPORTED_EXTENSIONS = [".js", ".json", ".node", ".mjs", ".ts", ".tsx"];

const hashOf = name => {
  return crypto
		.createHash("md4")
		.update(name)
		.digest("hex")
		.slice(0, 10);
}

const nodeLoader = eval('require(__dirname + "/loaders/node-loader.js")');
const relocateLoader = eval('require(__dirname + "/loaders/relocate-loader.js")');

module.exports = (
  entry,
  {
    cache,
    externals = [],
    filename = "index.js",
    minify = false,
    sourceMap = false,
    watch = false,
    v8cache = false
  } = {}
) => {
  const resolvedEntry = resolve.sync(entry);
  const shebangMatch = fs.readFileSync(resolvedEntry).toString().match(shebangRegEx);
  const mfs = new MemoryFS();
  const assetNames = Object.create(null);
  assetNames[filename] = true;
  if (sourceMap)
    assetNames[filename + '.map'] = true;
  if (v8cache)
    assetNames[filename + '.cache'] = assetNames[filename + '.cache.js'] = true;
  const resolvePlugins = [];
  let tsconfigMatchPath;
  const assetState = {
    assets: Object.create(null),
    assetNames,
    assetPermissions: undefined
  };
  assetState.assetNames[filename] = true;
  if (sourceMap)
    assetState.assetNames[filename + '.map'] = true;
  nodeLoader.setAssetState(assetState);
  relocateLoader.setAssetState(assetState);
  // add TsconfigPathsPlugin to support `paths` resolution in tsconfig
  // we need to catch here because the plugin will
  // error if there's no tsconfig in the working directory
  try {
    resolvePlugins.push(new TsconfigPathsPlugin({ silent: true }));

    const tsconfig = tsconfigPaths.loadConfig();
    if (tsconfig.resultType === "success") {
      tsconfigMatchPath = tsconfigPaths.createMatchPath(tsconfig.absoluteBaseUrl, tsconfig.paths);
    }
  } catch (e) {}

  const externalSet = new Set(externals);

  let watcher, watchHandler, rebuildHandler;

  const compiler = webpack({
    entry,
    cache: cache === false ? undefined : {
      type: "filesystem",
      cacheDirectory: typeof cache === 'string' ? cache : nccCacheDir,
      name: `ncc_${hashOf(entry)}`,
      version: require('../package.json').version
    },
    optimization: {
      nodeEnv: false,
      minimize: false
    },
    devtool: sourceMap ? "cheap-source-map" : false,
    mode: "production",
    target: "node",
    output: {
      path: "/",
      filename,
      libraryTarget: "commonjs2"
    },
    resolve: {
      extensions: SUPPORTED_EXTENSIONS,
      // webpack defaults to `module` and `main`, but that's
      // not really what node.js supports, so we reset it
      mainFields: ["main"],
      plugins: resolvePlugins
    },
    // https://github.com/zeit/ncc/pull/29#pullrequestreview-177152175
    node: false,
    externals: async ({ context, request }, callback) => {
      if (externalSet.has(request)) return callback(null, `commonjs ${request}`);
      if (request[0] === "." && (request[1] === "/" || request[1] === "." && request[2] === "/")) {
        if (request.startsWith("./node_modules/")) request = request.substr(15);
        else if (request.startsWith("../node_modules/")) request = request.substr(16);
        else return callback();
      }
      if (request[0] === "/" || /^[a-z]:\\/i.test(request) || nodeBuiltins.has(request) ||
          tsconfigMatchPath && tsconfigMatchPath(request, undefined, undefined, SUPPORTED_EXTENSIONS))
        return callback();
      const pkgNameMatch = request.match(pkgNameRegEx);
      if (pkgNameMatch) request = pkgNameMatch[0];
      let pkgPath = context + sep + 'node_modules' + sep + request;
      do {
        if (await new Promise((resolve, reject) =>
          compiler.inputFileSystem.stat(pkgPath, (err, stats) =>
            err && err.code !== 'ENOENT' ? reject(err) : resolve(stats ? stats.isDirectory() : false)
          )
        ))
          return callback();
      } while (pkgPath.length > (pkgPath = pkgPath.substr(0, pkgPath.lastIndexOf(sep, pkgPath.length - 15 - request.length)) + sep + 'node_modules' + sep + request).length);
      console.error(`ncc: Module directory "${context}" attempted to require "${request}" but could not be resolved, assuming external.`);
      return callback(null, `commonjs ${request}`);
    },
    module: {
      rules: [
        {
          test: /\.node$/,
          use: [{
            loader: eval('__dirname + "/loaders/node-loader.js"')
          }]
        },
        {
          test: /\.(js|mjs|tsx?)$/,
          use: [{
            loader: eval('__dirname + "/loaders/relocate-loader.js"'),
            options: { cwd: dirname(resolvedEntry) }
          }]
        },
        {
          test: /\.tsx?$/,
          use: [{
            loader: eval('__dirname + "/loaders/uncacheable.js"')
          },
          {
            loader: eval('__dirname + "/loaders/ts-loader.js"'),
            options: {
              compiler: eval('__dirname + "/typescript"'),
              compilerOptions: {
                outDir: '//'
              }
            }
          }]
        },
        {
          parser: { amd: false },
          exclude: /\.node$/,
          use: [{
            loader: eval('__dirname + "/loaders/shebang-loader.js"')
          }]
        }
      ]
    },
    plugins: [
      {
        apply(compiler) {
          /* compiler.hooks.afterCompile.tap("ncc", compilation => {
            compilation.cache.store('/NccPlugin/' + resolvedEntry, null, JSON.stringify(assetState.assetPermissions.permissions), (err) => {
              if (err) console.error(err);
            });
          }); */
          compiler.hooks.watchRun.tap("ncc", () => {
            if (rebuildHandler)
              rebuildHandler();
          });
          // override "not found" context to try built require first
          compiler.hooks.compilation.tap("ncc", compilation => {
            assetState.assetPermissions = Object.create(null);
            /* compilation.cache.get('/NccPlugin/' + resolvedEntry, null, (err, _assetPermissions) => {
              if (err) console.error(err);
              assetState.assetPermissions = JSON.parse(_assetPermissions || 'null') || Object.create(null);
            }); */
          });

          compiler.hooks.normalModuleFactory.tap("ncc", NormalModuleFactory => {
            function handler(parser) {
              parser.hooks.assign.for("require").intercept({
                register: tapInfo => {
                  if (tapInfo.name !== "CommonJsPlugin") {
                    return tapInfo;
                  }
                  tapInfo.fn = () => {};
                  return tapInfo;
                }
              });
            }
            NormalModuleFactory.hooks.parser
              .for("javascript/auto")
              .tap("ncc", handler);
            NormalModuleFactory.hooks.parser
              .for("javascript/dynamic")
              .tap("ncc", handler);

            return NormalModuleFactory;
          });
        }
      }
    ]
  });
  compiler.outputFileSystem = mfs;
  if (!watch) {
    return new Promise((resolve, reject) => {
      compiler.run((err, stats) => {
        if (err) return reject(err);
        compiler.close(err => {
          if (err) return reject(err);
          if (stats.hasErrors())
            return reject(new Error(stats.toString()));
          resolve();
        });
      });
    })
    .then(finalizeHandler);
  }
  else {
    let cachedResult;
    watcher = compiler.watch({}, (err, stats) => {
      if (err) return reject(err);
      if (err)
        return watchHandler({ err });
      if (stats.hasErrors())
        return watchHandler({ err: stats.toString() });
      const { code, map, assets } = finalizeHandler();
      // clear output file system
      mfs.data = {};
      if (watchHandler)
        watchHandler({ code, map, assets, err: null });
      else
        cachedResult = { code, map, assets};
    });
    let closed = false;
    return {
      close () {
        if (!watcher)
          throw new Error('No watcher to close.');
        if (closed)
          throw new Error('Watcher already closed.');
        closed = true;
        watcher.close();
      },
      handler (handler) {
        if (watchHandler)
          throw new Error('Watcher handler already provided.');
        watchHandler = handler;
        if (cachedResult) {
          handler(cachedResult);
          cachedResult = null;
        }
      },
      rebuild (handler) {
        if (rebuildHandler)
          throw new Error('Rebuild handler already provided.');
        rebuildHandler = handler;
      }
    };
  }

  function finalizeHandler () {
    const assets = Object.create(null);
    getFlatFiles(mfs.data, assets, assetState.assetPermissions);
    delete assets[filename];
    delete assets[filename + ".map"];
    let code = mfs.readFileSync(`/${filename}`, "utf8");
    let map = sourceMap ? mfs.readFileSync(`/${filename}.map`, "utf8") : null;

    if (minify) {
      const result = terser.minify(code, {
        compress: false,
        mangle: {
          keep_classnames: true,
          keep_fnames: true
        },
        sourceMap: sourceMap ? {
          content: map,
          filename,
          url: filename + ".map"
        } : false
      });
      // For some reason, auth0 returns "undefined"!
      // custom terser phase used over Webpack integration for this reason
      if (result.code !== undefined)
        ({ code, map } = { code: result.code, map: result.map });
    }

    if (v8cache) {
      const { Script } = require('vm');
      assets[filename + '.cache'] = new Script(code).createCachedData();
      assets[filename + '.cache.js'] = code;
      if (map)
        assets[filename + '.map'] = map;
      code = `const { readFileSync } = require('fs'), { Script } = require('vm'), { wrap } = require('module');\n` +
          `const source = readFileSync(__dirname + '/${filename}.cache.js').toString(), cachedData = readFileSync(__dirname + '/${filename}.cache');\n` +
          `(new Script(wrap(source), { cachedData }).runInThisContext())(exports, require, module, __filename, __dirname);\n`;
      if (map) map = {};
    }

    if (shebangMatch) {
      code = shebangMatch[0] + code;
      // add a line offset to the sourcemap
      if (map)
        map.mappings = ";" + map.mappings;
    }

    return { code, map, assets };
  }
};

// this could be rewritten with actual FS apis / globs, but this is simpler
function getFlatFiles(mfsData, output, assetPermissions, curBase = "") {
  for (const path of Object.keys(mfsData)) {
    const item = mfsData[path];
    const curPath = curBase + "/" + path;
    // directory
    if (item[""] === true) getFlatFiles(item, output, assetPermissions, curPath);
    // file
    else if (!curPath.endsWith("/")) {
      output[curPath.substr(1)] = {
        source: mfsData[path],
        permissions: assetPermissions[curPath.substr(1)]
      }
    }
  }
}
