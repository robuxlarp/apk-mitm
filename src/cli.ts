import * as path from 'path'
import * as fs from './utils/fs'
import parseArgs = require('yargs-parser')
import chalk = require('chalk')
import Listr = require('listr')
// tempy removed (no longer used)

import patchApk, { showAppBundleWarning } from './patch-apk'
import { patchXapkBundle, patchApksBundle } from './patch-app-bundle'

import Apktool from './tools/apktool'
import UberApkSigner from './tools/uber-apk-signer'
import Tool from './tools/tool'
import UserError from './utils/user-error'

// Import package.json to read the package version at runtime
// Note: tsconfig.json must have "resolveJsonModule": true and "esModuleInterop": true
import pkg from '../package.json'

export type TaskOptions = {
  inputPath: string
  outputPath: string
  skipPatches: boolean
  certificatePath?: string
  mapsApiKey?: string
  apktool: Apktool
  uberApkSigner: UberApkSigner
  tmpDir: string
  wait: boolean
  isAppBundle: boolean
  debuggable: boolean
  skipDecode: boolean
  skipEncode?: boolean
}

export default async function cli() {
  const args = parseArgs(process.argv.slice(2), {
    string: ['apktool', 'certificate', 'tmp-dir', 'maps-api-key', 'out-dir'],
    boolean: [
      'help',
      'skip-patches',
      'wait',
      'debuggable',
      'keep-tmp-dir',
      'skip-encode',
    ],
  })

  if (args.help) {
    showHelp()
    process.exit()
  }

  const [input] = args._
  if (!input) {
    showHelp()
    process.exit(1)
  }
  const inputPath = path.resolve(input)

  const { taskFunction, skipDecode, isAppBundle, outputName } =
    await determineTask(inputPath)
  const outputPath = path.resolve(path.dirname(inputPath), outputName)

  // Initialize and validate certificate path
  let certificatePath: string | undefined
  const mapsApiKey: string | undefined = args['maps-api-key']
  if (args.certificate) {
    certificatePath = path.resolve(args.certificate)
    let certificateExtension = path.extname(certificatePath)

    if (certificateExtension !== '.pem' && certificateExtension !== '.der') {
      showSupportedCertificateExtensions()
    }
  }

  // Compute a sensible default "working" directory for decode/output if the user
  // didn't provide an explicit tmp-dir or out-dir. This puts the files where
  // you're running the command (current working directory) instead of a random
  // temp path.
  const baseName = path.basename(inputPath, path.extname(inputPath))

  let tmpDir: string
  if (args['out-dir']) {
    tmpDir = path.resolve(args['out-dir'])
  } else if (args['tmp-dir']) {
    tmpDir = path.resolve(args['tmp-dir'])
  } else {
    // Default to a directory in the current working directory.
    tmpDir = skipDecode
      ? path.join(process.cwd(), `${baseName}-apk-mitm`)
      : path.join(process.cwd(), `${baseName}-decode`)
  }

  await fs.mkdir(tmpDir, { recursive: true })

  const apktool = new Apktool({
    frameworkPath: path.join(tmpDir, 'framework'),
    customPath: args.apktool ? path.resolve(args.apktool) : undefined,
  })
  const uberApkSigner = new UberApkSigner()

  showVersions({ apktool, uberApkSigner })
  if (skipDecode) {
    console.log(
      chalk.dim(`  Patching from decoded apktool directory:\n  ${inputPath}\n`),
    )
  } else {
    console.log(chalk.dim(`  Using working directory:\n  ${tmpDir}\n`))
  }

  taskFunction({
    inputPath,
    outputPath,
    certificatePath,
    mapsApiKey,
    tmpDir,
    apktool,
    uberApkSigner,
    wait: args.wait,
    skipPatches: args.skipPatches,
    isAppBundle,
    debuggable: args.debuggable,
    skipDecode,
    skipEncode: args['skip-encode'],
  })
    .run()
    .then(async context => {
      if (taskFunction === patchApk && context.usesAppBundle) {
        showAppBundleWarning()
      }

      // If we skipped encoding we should give the user the path to the patched decode dir
      if (args['skip-encode']) {
        const patchedDir = skipDecode ? inputPath : path.join(tmpDir, 'decode')
        console.log(
          chalk`\n  {green.inverse  Done! } Patched (decoded) files are in: {bold ${patchedDir}}\n`,
        )
      } else {
        console.log(
          chalk`\n  {green.inverse  Done! } Patched file: {bold ./${outputName}}\n`,
        )
      }

      // Don't delete tmp dir if user asked to keep it OR if they used skip-encode
      // OR if they explicitly provided an out-dir.
      if (!args['keep-tmp-dir'] && !args['skip-encode'] && !args['out-dir']) {
        try {
          await fs.rm(tmpDir, { recursive: true, force: true })
        } catch (error: any) {
          // No idea why Windows gives us an `EBUSY: resource busy or locked`
          // error here, but deleting the temporary directory isn't the most
          // important thing in the world, so let's just ignore it
          const ignoreError =
            process.platform === 'win32' && error.code === 'EBUSY'

          if (!ignoreError) throw error
        }
      }
    })
}

function showHelp() {
  console.log(chalk`
  $ {bold apk-mitm} <path-to-apk/xapk/apks/decoded-directory>

  {blue {dim.bold *} Optional flags:}
  {dim {bold --wait} Wait for manual changes before re-encoding}
  {dim {bold --tmp-dir <path>} Where temporary files will be stored}
  {dim {bold --out-dir <path>} Where decoded/working files should go (defaults to current working directory)}
  {dim {bold --keep-tmp-dir} Don't delete the temporary directory after patching}
  {dim {bold --debuggable} Make the patched app debuggable}
  {dim {bold --skip-patches} Don't apply any patches (for troubleshooting)}
  {dim {bold --apktool <path-to-jar>} Use custom version of Apktool}
  {dim {bold --certificate <path-to-pem/der>} Add specific certificate to network security config}
  {dim {bold --maps-api-key <api-key>} Add custom Google Maps API key to be replaced while patching apk}
  {dim {bold --skip-encode} Skip the encoding and signing steps and keep the patched decode directory}
  `)
}

/**
 * Error that is shown when the file provided through the positional argument
 * has an unsupported extension. Exits with status 1 after showing the message.
 */
function showSupportedExtensions(): never {
  console.log(chalk`{yellow
  It looks like you tried running {bold apk-mitm} with an unsupported file type!

  Only the following file extensions are supported: {bold .apk}, {bold .xapk}, and {bold .apks} (or {bold .zip})
  }`)

  process.exit(1)
}

/**
 * Error that is shown when the file provided through the `--certificate` flag
 * has an unsupported extension. Exits with status 1 after showing the message.
 */
function showSupportedCertificateExtensions(): never {
  console.log(chalk`{yellow
  It looks like the certificate file you provided is unsupported!

  Only {bold .pem} and {bold .der} certificate files are supported.
  }`)

  process.exit(1)
}

async function determineTask(inputPath: string) {
  const fileStats = await fs.stat(inputPath)

  let outputFileExtension = '.apk'

  let skipDecode = false
  let isAppBundle = false
  let taskFunction: (options: TaskOptions) => Listr

  if (fileStats.isDirectory()) {
    taskFunction = patchApk
    skipDecode = true

    const apktoolYamlPath = path.join(inputPath, 'apktool.yml')
    if (!(await fs.exists(apktoolYamlPath))) {
      throw new UserError(
        'No "apktool.yml" file found inside the input directory!' +
          ' Make sure to specify a directory created by "apktool decode".',
      )
    }
  } else {
    const inputFileExtension = path.extname(inputPath)

    switch (inputFileExtension) {
      case '.apk':
        taskFunction = patchApk
        break
      case '.xapk':
        isAppBundle = true
        taskFunction = patchXapkBundle
        break
      case '.apks':
      case '.zip':
        isAppBundle = true
        taskFunction = patchApksBundle
        break
      default:
        showSupportedExtensions()
    }

    outputFileExtension = inputFileExtension
  }

  const baseName = path.basename(inputPath, outputFileExtension)
  const outputName = `${baseName}-patched${outputFileExtension}`

  return { skipDecode, taskFunction, isAppBundle, outputName }
}

export function showVersions({
  apktool,
  uberApkSigner,
}: {
  apktool: Tool
  uberApkSigner: Tool
}) {
  console.log(chalk`
  {dim ╭} {blue {bold apk-mitm} v${pkg.version}}
  {dim ├ {bold apktool} ${apktool.version.name}
  ╰ {bold uber-apk-signer} ${uberApkSigner.version.name}}
  `)
}

export function showArmWarning() {
  console.log(chalk`{yellow
  {inverse.bold  NOTE }

  {bold apk-mitm} doesn't officially support ARM-based devices (like Raspberry Pi's)
  at the moment, so the error above might be a result of that. Please try
  patching this APK on a device with a more common CPU architecture like x64
  before reporting an issue.
  }`)
}  const apktool = new Apktool({
    frameworkPath: path.join(tmpDir, 'framework'),
    customPath: args.apktool ? path.resolve(args.apktool) : undefined,
  })
  const uberApkSigner = new UberApkSigner()

  showVersions({ apktool, uberApkSigner })
  if (skipDecode) {
    console.log(
      chalk.dim(`  Patching from decoded apktool directory:\n  ${inputPath}\n`),
    )
  } else {
    console.log(chalk.dim(`  Using working directory:\n  ${tmpDir}\n`))
  }

  taskFunction({
    inputPath,
    outputPath,
    certificatePath,
    mapsApiKey,
    tmpDir,
    apktool,
    uberApkSigner,
    wait: args.wait,
    skipPatches: args.skipPatches,
    isAppBundle,
    debuggable: args.debuggable,
    skipDecode,
    skipEncode: args['skip-encode'],
  })
    .run()
    .then(async context => {
      if (taskFunction === patchApk && context.usesAppBundle) {
        showAppBundleWarning()
      }

      // If we skipped encoding we should give the user the path to the patched decode dir
      if (args['skip-encode']) {
        const patchedDir = skipDecode ? inputPath : path.join(tmpDir, 'decode')
        console.log(
          chalk`\n  {green.inverse  Done! } Patched (decoded) files are in: {bold ${patchedDir}}\n`,
        )
      } else {
        console.log(
          chalk`\n  {green.inverse  Done! } Patched file: {bold ./${outputName}}\n`,
        )
      }

      // Don't delete tmp dir if user asked to keep it OR if they used skip-encode
      // OR if they explicitly provided an out-dir.
      if (!args['keep-tmp-dir'] && !args['skip-encode'] && !args['out-dir']) {
        try {
          await fs.rm(tmpDir, { recursive: true, force: true })
        } catch (error: any) {
          // No idea why Windows gives us an `EBUSY: resource busy or locked`
          // error here, but deleting the temporary directory isn't the most
          // important thing in the world, so let's just ignore it
          const ignoreError =
            process.platform === 'win32' && error.code === 'EBUSY'

          if (!ignoreError) throw error
        }
      }
    })
}

function showHelp() {
  console.log(chalk`
  $ {bold apk-mitm} <path-to-apk/xapk/apks/decoded-directory>

  {blue {dim.bold *} Optional flags:}
  {dim {bold --wait} Wait for manual changes before re-encoding}
  {dim {bold --tmp-dir <path>} Where temporary files will be stored}
  {dim {bold --out-dir <path>} Where decoded/working files should go (defaults to current working directory)}
  {dim {bold --keep-tmp-dir} Don't delete the temporary directory after patching}
  {dim {bold --debuggable} Make the patched app debuggable}
  {dim {bold --skip-patches} Don't apply any patches (for troubleshooting)}
  {dim {bold --apktool <path-to-jar>} Use custom version of Apktool}
  {dim {bold --certificate <path-to-pem/der>} Add specific certificate to network security config}
  {dim {bold --maps-api-key <api-key>} Add custom Google Maps API key to be replaced while patching apk}
  {dim {bold --skip-encode} Skip the encoding and signing steps and keep the patched decode directory}
  `)
}

/**
 * Error that is shown when the file provided through the positional argument
 * has an unsupported extension. Exits with status 1 after showing the message.
 */
function showSupportedExtensions(): never {
  console.log(chalk`{yellow
  It looks like you tried running {bold apk-mitm} with an unsupported file type!

  Only the following file extensions are supported: {bold .apk}, {bold .xapk}, and {bold .apks} (or {bold .zip})
  }`)

  process.exit(1)
}

/**
 * Error that is shown when the file provided through the `--certificate` flag
 * has an unsupported extension. Exits with status 1 after showing the message.
 */
function showSupportedCertificateExtensions(): never {
  console.log(chalk`{yellow
  It looks like the certificate file you provided is unsupported!

  Only {bold .pem} and {bold .der} certificate files are supported.
  }`)

  process.exit(1)
}

async function determineTask(inputPath: string) {
  const fileStats = await fs.stat(inputPath)

  let outputFileExtension = '.apk'

  let skipDecode = false
  let isAppBundle = false
  let taskFunction: (options: TaskOptions) => Listr

  if (fileStats.isDirectory()) {
    taskFunction = patchApk
    skipDecode = true

    const apktoolYamlPath = path.join(inputPath, 'apktool.yml')
    if (!(await fs.exists(apktoolYamlPath))) {
      throw new UserError(
        'No "apktool.yml" file found inside the input directory!' +
          ' Make sure to specify a directory created by "apktool decode".',
      )
    }
  } else {
    const inputFileExtension = path.extname(inputPath)

    switch (inputFileExtension) {
      case '.apk':
        taskFunction = patchApk
        break
      case '.xapk':
        isAppBundle = true
        taskFunction = patchXapkBundle
        break
      case '.apks':
      case '.zip':
        isAppBundle = true
        taskFunction = patchApksBundle
        break
      default:
        showSupportedExtensions()
    }

    outputFileExtension = inputFileExtension
  }

  const baseName = path.basename(inputPath, outputFileExtension)
  const outputName = `${baseName}-patched${outputFileExtension}`

  return { skipDecode, taskFunction, isAppBundle, outputName }
}

export function showVersions({
  apktool,
  uberApkSigner,
}: {
  apktool: Tool
  uberApkSigner: Tool
}) {
  console.log(chalk`
  {dim ╭} {blue {bold apk-mitm} v${version}}
  {dim ├ {bold apktool} ${apktool.version.name}
  ╰ {bold uber-apk-signer} ${uberApkSigner.version.name}}
  `)
}

export function showArmWarning() {
  console.log(chalk`{yellow
  {inverse.bold  NOTE }

  {bold apk-mitm} doesn't officially support ARM-based devices (like Raspberry Pi's)
  at the moment, so the error above might be a result of that. Please try
  patching this APK on a device with a more common CPU architecture like x64
  before reporting an issue.
  }`)
}
