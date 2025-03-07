/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

// This file is largely based upon the work done for node-pre-gyp. We are not
// using that module directly due to issues we've run into with the intricacies
// of various node and npm versions that we must support.
// https://www.npmjs.com/package/node-pre-gyp

// XXX This file must not have any deps. This file will run during the install
// XXX step of the module and we are _not_ guaranteed that the dependencies have
// XXX already installed. Core modules are okay.
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const semver = require('semver')
const zlib = require('zlib')
const ProxyAgent = require('https-proxy-agent')

const {
  getBinFileName,
  getPackageFileName,
  parseArgs,
  logStart,
  logFinish,
  PACKAGE_ROOT,
  BUILD_PATH,
  REMOTE_PATH,
  IS_WIN
} = require('./common')
const { execGyp, gypVersion } = require('./gyp-utils')

const CPU_COUNT = os.cpus().length
const DOWNLOAD_HOST =
  process.env.NR_NATIVE_METRICS_DOWNLOAD_HOST || 'https://download.newrelic.com/'

const opts = {}
const preBuild = module.exports

preBuild.load = function load(target) {
  return require(path.join(BUILD_PATH, getBinFileName(target)))
}

preBuild.makePath = function makePath(pathToMake, cb) {
  const accessRights = fs.constants.R_OK | fs.constants.W_OK

  // We only want to make the parts after the package directory.
  pathToMake = path.join(PACKAGE_ROOT, pathToMake)
  fs.access(pathToMake, accessRights, function fsAccessCB(err) {
    if (!err) {
      return cb()
    } else if (err?.code !== 'ENOENT') {
      // It exists but we don't have read+write access! This is a problem.
      return cb(new Error(`Do not have access to '${pathToMake}': ${err}`))
    }

    // It probably does not exist, so try to make it.
    fs.mkdir(pathToMake, { recursive: true }, function fsMkDirDb(mkdirErr) {
      if (mkdirErr) {
        return cb(mkdirErr)
      }

      cb()
    })
  })
}

preBuild.build = function build(target, rebuild, cb) {
  const HAS_OLD_NODE_GYP_ARGS_FOR_WINDOWS = semver.lt(gypVersion() || '0.0.0', '3.7.0')

  if (IS_WIN && HAS_OLD_NODE_GYP_ARGS_FOR_WINDOWS) {
    target = '/t:' + target
  }

  const cmds = rebuild ? ['clean', 'configure'] : ['configure']

  execGyp(cmds, opts, function cleanCb(err) {
    if (err) {
      return cb(err)
    }

    const jobs = Math.round(CPU_COUNT / 2)
    execGyp(['build', '-j', jobs, target], opts, cb)
  })
}

preBuild.moveBuild = function moveBuild(target, cb) {
  const filePath = path.join(BUILD_PATH, target + '.node')
  const destination = path.join(BUILD_PATH, getBinFileName(target))
  fs.rename(filePath, destination, cb)
}

/**
 * Pipes the response and gunzip and unzips the data
 *
 * @param {Object} params
 * @param {http.ServerResponse} params.res response from download site
 * @param {string} url download url
 * @param {Function} cb callback when download is done
 */
function unzipFile(url, cb, res) {
  if (res.statusCode === 404) {
    return cb(new Error('No pre-built artifacts for your OS/architecture.'))
  } else if (res.statusCode !== 200) {
    return cb(new Error('Failed to download ' + url + ': code ' + res.statusCode))
  }

  let hasCalledBack = false
  const unzip = zlib.createGunzip()
  const buffers = []
  let size = 0

  res.pipe(unzip).on('data', function onResData(data) {
    buffers.push(data)
    size += data.length
  })

  res.on('error', function onResError(err) {
    if (!hasCalledBack) {
      hasCalledBack = true
      cb(new Error('Failed to download ' + url + ': ' + err.message))
    }
  })

  unzip.on('error', function onResError(err) {
    if (!hasCalledBack) {
      hasCalledBack = true
      cb(new Error('Failed to unzip ' + url + ': ' + err.message))
    }
  })

  unzip.on('end', function onResEnd() {
    if (hasCalledBack) {
      return
    }
    hasCalledBack = true
    cb(null, Buffer.concat(buffers, size))
  })

  res.resume()
}

function setupRequest(url, fileName) {
  let client = null
  let options = {}
  const proxyHost = process.env.NR_NATIVE_METRICS_PROXY_HOST

  if (proxyHost) {
    const parsedUrl = new URL(DOWNLOAD_HOST)
    options = parsedUrl
    options.path = REMOTE_PATH + fileName
    options.agent = new ProxyAgent(proxyHost)
    client = /^https:/.test(proxyHost) ? https : http
  } else {
    options = url
    if (DOWNLOAD_HOST.startsWith('https:')) {
      client = https
    } else {
      // eslint-disable-next-line no-console
      console.log(`Falling back to http, please consider enabling SSL on ${DOWNLOAD_HOST}`)
      client = http
    }
  }

  return { client, options }
}

preBuild.download = function download(target, cb) {
  const fileName = getPackageFileName(target)
  const url = DOWNLOAD_HOST + REMOTE_PATH + fileName
  const { client, options } = setupRequest(url, fileName)

  client.get(options, unzipFile.bind(null, url, cb))
}

preBuild.saveDownload = function saveDownload(target, data, cb) {
  preBuild.makePath(BUILD_PATH, function makePathCB(err) {
    if (err) {
      return cb(err)
    }

    const filePath = path.join(BUILD_PATH, getBinFileName(target))
    fs.writeFile(filePath, data, cb)
  })
}

preBuild.install = function install(target, cb) {
  const errors = []

  const noBuild = opts['no-build'] || process.env.NR_NATIVE_METRICS_NO_BUILD
  const noDownload = opts['no-download'] || process.env.NR_NATIVE_METRICS_NO_DOWNLOAD

  // If NR_NATIVE_METRICS_NO_BUILD env var is specified, jump straight to downloading
  if (noBuild) {
    return doDownload()
  }

  // Otherwise, first attempt to build the package using the source. If that fails, try
  // downloading the package. If that also fails, whoops!
  preBuild.build(target, true, function buildCB(buildErr) {
    if (!buildErr) {
      return preBuild.moveBuild(target, function moveBuildCB(moveErr) {
        if (moveErr) {
          errors.push(moveErr)
          doDownload()
        } else {
          doCallback()
        }
      })
    }
    errors.push(buildErr)

    // Building failed, try downloading.
    doDownload()
  })

  function doDownload() {
    if (noDownload && !noBuild) {
      return doCallback(new Error('Downloading is disabled.'))
    }

    preBuild.download(target, function downloadCB(err, data) {
      if (err) {
        return doCallback(err)
      }

      preBuild.saveDownload(target, data, doCallback)
    })
  }

  function doCallback(err) {
    if (err) {
      errors.push(err)
      cb(err)
    } else {
      cb()
    }
  }
}

preBuild.executeCli = function executeCli(cmd, target) {
  logStart(cmd)
  if (cmd === 'build' || cmd === 'rebuild') {
    preBuild.build(target, cmd === 'rebuild', function buildCb(err) {
      if (err) {
        logFinish(cmd, target, err)
      } else {
        preBuild.moveBuild(target, logFinish.bind(this, cmd, target))
      }
    })
  } else if (cmd === 'install') {
    preBuild.install(target, logFinish.bind(this, cmd, target))
  }
}

if (require.main === module) {
  const [, , cmd, target] = parseArgs(process.argv, opts)
  preBuild.executeCli(cmd, target)
}
