#!/usr/bin/env node

/**
 * YTTOOL - YouTube Tool
 * Unified CLI tool for YouTube operations (convert to MP3, download playlists, transcribe, etc.)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import crypto from 'crypto';
import { platform } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root when set (e.g. by xyztools-cli); defaults to this file's directory */
const PACKAGE_ROOT = process.env.YTTOOL_ROOT
  ? path.resolve(process.env.YTTOOL_ROOT)
  : __dirname;

/**
 * yt-dlp binary (desktop bundles set YT_DLP_PATH to an absolute path).
 */
function ytDlpExe() {
  return process.env.YT_DLP_PATH || 'yt-dlp';
}

/** Extra yt-dlp args (e.g. bundled ffmpeg). */
function ytDlpCommonArgs() {
  const ff = process.env.XYZTOOLS_FFMPEG_PATH;
  if (ff && existsSync(ff)) return ['--ffmpeg-location', ff];
  return [];
}

/** Default Node stdout cap (~1 MiB) is too small for large playlist --dump-json output. */
const YT_DLP_MAX_BUFFER = 64 * 1024 * 1024;

function ytDlpExecSync(extraArgs, options = {}) {
  return execFileSync(ytDlpExe(), [...ytDlpCommonArgs(), ...extraArgs], {
    encoding: 'utf-8',
    maxBuffer: YT_DLP_MAX_BUFFER,
    ...options,
  });
}

/**
 * Sanitize URL by removing backslash escapes (fixes zsh auto-escaping issue)
 */
function sanitizeUrl(url) {
  if (!url) return url;
  return url.replace(/\\/g, '');
}

/**
 * Generate a short hash from text
 */
function generateShortHash(text) {
  return crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
}

/**
 * Check if yt-dlp is installed
 */
function checkYtDlp() {
  const y = process.env.YT_DLP_PATH;
  if (y && existsSync(y)) return true;
  try {
    if (platform === 'win32') execSync('where yt-dlp', { stdio: 'ignore' });
    else execSync('which yt-dlp', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Get video information using yt-dlp
 */
function getVideoInfo(url) {
  try {
    const output = ytDlpExecSync(['--dump-json', '--no-warnings', '--quiet', '--no-playlist', url]);
    const info = JSON.parse(output.trim().split('\n')[0]);
    return {
      title: info.title || 'Unknown',
      id: info.id || '',
      duration: info.duration || 0,
    };
  } catch (e) {
    console.log(chalk.yellow(`⚠️  Could not fetch video info: ${e.message}`));
    return {
      title: 'Unknown',
      id: '',
      duration: 0,
    };
  }
}

/**
 * Get playlist information including number of entries
 */
function getPlaylistInfo(url) {
  try {
    let playlistInfo = null;
    try {
      const infoOutput = ytDlpExecSync(['--dump-json', '--no-warnings', '--quiet', url]);
      playlistInfo = JSON.parse(infoOutput.trim().split('\n')[0]);
    } catch (e) {
      // Not a playlist or error, continue
    }

    if (playlistInfo && playlistInfo._type === 'playlist') {
      const flatOutput = ytDlpExecSync([
        '--flat-playlist',
        '--dump-json',
        '--no-warnings',
        '--quiet',
        url,
      ]);
      const lines = flatOutput.trim().split('\n').filter((line) => line.trim());

      const videoEntries = lines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          return entry._type === 'video' || (entry.id && !entry._type);
        } catch (e) {
          return false;
        }
      });

      return {
        title: playlistInfo.title || 'Unknown Playlist',
        count: videoEntries.length || lines.length,
        entries: videoEntries,
      };
    }

    return null;
  } catch (e) {
    console.log(chalk.yellow(`⚠️  Could not fetch playlist info: ${e.message}`));
    return null;
  }
}

/** Resolve flat-playlist JSON lines to watch URLs. */
function playlistVideoUrls(playlistInfo) {
  const urls = [];
  for (const line of playlistInfo.entries || []) {
    try {
      const entry = typeof line === 'string' ? JSON.parse(line) : line;
      const id = entry.id;
      if (!id) continue;
      urls.push(`https://www.youtube.com/watch?v=${id}`);
    } catch {
      /* skip malformed line */
    }
  }
  return urls;
}

/**
 * Root directory where per-video job folders are created (matches whisper_transcribe / desktop env).
 */
function getOutputDir() {
  const o = process.env.XYZTOOLS_OUTPUT_DIR?.trim();
  if (o) {
    const abs = path.isAbsolute(o) ? o : path.resolve(process.cwd(), o);
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    }
    return abs;
  }
  const outputDir = path.join(process.cwd(), 'output');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * Safe single path segment / file basename from a YouTube title (no path separators).
 */
function sanitizeForFsName(name, maxLen = 120) {
  if (!name || !String(name).trim()) return 'Unknown';
  let s = String(name).replace(/[\x00-\x1f]/g, '');
  s = s.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[.\s]+$/g, '');
  if (!s) s = 'Unknown';
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/**
 * One folder per video under outputRoot: basename matches folder name.
 * Uses `title` + `_` + `videoId` when id is present so re-runs and collisions stay deterministic.
 */
function prepareJobOutput(outputRoot, title, videoId, url) {
  mkdirSync(outputRoot, { recursive: true });
  const stem = sanitizeForFsName(title);
  const base =
    videoId && String(videoId).trim()
      ? `${stem}_${String(videoId).trim()}`
      : `${stem}_${generateShortHash(url)}`;
  const jobDir = path.join(outputRoot, base);
  if (!existsSync(jobDir)) {
    mkdirSync(jobDir, { recursive: true });
  }
  return { jobDir, fileBase: base };
}

/**
 * Convert video to MP3
 */
function convertToMp3(url, outputDir = null) {
  if (!checkYtDlp()) {
    const msg = 'yt-dlp not found. Install with: brew install yt-dlp';
    console.log(chalk.red(`❌ Error: ${msg}`));
    throw new Error(msg);
  }
  
  if (outputDir === null) {
    outputDir = getOutputDir();
  }
  
  // Get video info for filename
  console.log('📥 Fetching video information...');
  const videoInfo = getVideoInfo(url);
  const title = videoInfo.title;
  const { jobDir, fileBase } = prepareJobOutput(outputDir, title, videoInfo.id, url);
  const filename = `${fileBase}.mp3`;
  const outputPath = path.join(jobDir, filename);
  
  console.log(chalk.blue(`🎵 Converting to MP3: ${title}`));
  console.log(chalk.blue(`📁 Output: ${outputPath}`));
  
  const outputPattern = outputPath.replace('.mp3', '.%(ext)s');
  const args = [
    ...ytDlpCommonArgs(),
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '192K',
    '--embed-metadata',
    '--embed-thumbnail',
    '-o',
    outputPattern,
    url,
  ];

  try {
    execFileSync(ytDlpExe(), args, { stdio: 'inherit' });
    
    // Check if file was created
    if (existsSync(outputPath)) {
      console.log(chalk.green(`✅ Successfully converted: ${outputPath}`));
    } else {
      // Try to find the file with different extension
      const basePath = outputPath.replace('.mp3', '');
      const extensions = ['.mp3', '.m4a', '.webm', '.opus'];
      let found = false;
      
      for (const ext of extensions) {
        const testPath = basePath + ext;
        if (existsSync(testPath)) {
          if (ext !== '.mp3') {
            renameSync(testPath, outputPath);
          }
          console.log(chalk.green(`✅ Successfully converted: ${outputPath}`));
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log(chalk.yellow(`⚠️  File created but path may differ. Check: ${outputDir}`));
      }
    }
    
    return outputPath;
  } catch (e) {
    console.log(chalk.red(`❌ Error converting to MP3: ${e.message}`));
    throw e;
  }
}

/**
 * Convert playlist to MP3 using yt-dlp native playlist support
 */
function convertPlaylistToMp3(url, outputDir = null) {
  if (!checkYtDlp()) {
    const msg = 'yt-dlp not found. Install with: brew install yt-dlp';
    console.log(chalk.red(`❌ Error: ${msg}`));
    throw new Error(msg);
  }
  
  if (outputDir === null) {
    outputDir = getOutputDir();
  }
  
  // Get playlist info for display (optional)
  console.log('📋 Fetching playlist information...');
  const playlistInfo = getPlaylistInfo(url);
  
  let playlistTitle;
  if (playlistInfo) {
    playlistTitle = playlistInfo.title;
    const totalCount = playlistInfo.count;
    console.log(chalk.blue(`📚 Playlist: ${playlistTitle}`));
    console.log(chalk.blue(`📊 Found ${totalCount} videos`));
  } else {
    playlistTitle = 'Playlist';
    console.log(chalk.blue('📚 Processing playlist...'));
  }
  
  console.log(chalk.blue(`\n🔄 Downloading entire playlist...`));
  console.log(chalk.blue(`📁 Files will be saved to: ${outputDir}`));
  console.log(chalk.blue(`📝 Each file will be named: [Video Title].mp3\n`));
  
  // Use yt-dlp's native playlist support
  // Output template: %(playlist)s/%(title)s.%(ext)s
  // This creates a folder named after the playlist and files named by title
  const outputTemplate = path.join(outputDir, '%(playlist)s', '%(title)s.%(ext)s');
  const args = [
    ...ytDlpCommonArgs(),
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '192K',
    '--embed-metadata',
    '--embed-thumbnail',
    '--yes-playlist',
    '--ignore-errors',
    '-o',
    outputTemplate,
    url,
  ];

  try {
    execFileSync(ytDlpExe(), args, { stdio: 'inherit' });
    console.log(chalk.cyan(`\n${'='.repeat(60)}`));
    console.log(chalk.green('✅ Playlist download completed!'));
    console.log(chalk.blue(`📁 Files saved to: ${path.join(outputDir, playlistTitle)}`));
    console.log(chalk.cyan(`${'='.repeat(60)}`));
  } catch (e) {
    console.log(chalk.red(`\n❌ Error downloading playlist: ${e.message}`));
    console.log(chalk.yellow('💡 Some videos may have been downloaded successfully. Check the output directory.'));
    throw e;
  }
}

/**
 * Convert one video to text transcript - tries index.js first, falls back to whisper_transcribe.py
 */
function convertToTxtOneVideo(url, outputRootDir = null) {
  const ffm = process.env.XYZTOOLS_FFMPEG_PATH;
  if (ffm && existsSync(ffm)) {
    const d = path.dirname(path.resolve(ffm));
    process.env.PATH = `${d}${path.delimiter}${process.env.PATH || ''}`;
  }

  const root = outputRootDir ?? getOutputDir();
  console.log('📥 Fetching video information (for output folder / names)...');
  const videoInfo = getVideoInfo(url);
  const { jobDir, fileBase } = prepareJobOutput(root, videoInfo.title, videoInfo.id, url);

  const exportMd = process.env.XYZTOOLS_EXPORT_MD === '1';
  const mdOnly = process.env.XYZTOOLS_MD_ONLY === '1';

  // First try index.js (faster, but may fail due to YouTube restrictions)
  const indexScriptPath = path.join(PACKAGE_ROOT, 'index.js');
  const whisperScriptPath = path.join(PACKAGE_ROOT, 'whisper_transcribe.py');
  
  const childEnv = {
    ...process.env,
    XYZTOOLS_VIDEO_TITLE: videoInfo.title,
    XYZTOOLS_VIDEO_URL: sanitizeUrl(url),
  };

  if (existsSync(indexScriptPath)) {
    console.log(chalk.blue('🔄 Trying fast transcript extraction (index.js)...'));
    try {
      const indexArgs = [
        indexScriptPath,
        url,
        '--job-dir',
        jobDir,
        '--basename',
        fileBase,
        '--format',
        'timestamped',
        '--no-print',
        '--video-title',
        videoInfo.title,
      ];
      if (exportMd) {
        indexArgs.push('--markdown');
      }
      if (mdOnly) {
        indexArgs.push('--md-only');
      }
      execFileSync(process.execPath, indexArgs, { stdio: 'inherit', env: childEnv });
      console.log(chalk.green('✅ Transcript generation completed'));
      return;
    } catch (e) {
      console.log(chalk.yellow('\n⚠️  Fast extraction failed (YouTube restrictions).'));
      console.log(chalk.yellow('🔄 Falling back to Whisper AI (more reliable)...\n'));
    }
  }
  
  // Fallback to Whisper (more reliable, works for any video)
  if (existsSync(whisperScriptPath)) {
    try {
      const venvPython3 = path.join(PACKAGE_ROOT, 'whisper-env', 'bin', 'python3');
      const venvPython = path.join(PACKAGE_ROOT, 'whisper-env', 'bin', 'python');
      let pythonCmd = null;

      const envPy = process.env.XYZTOOLS_PYTHON;
      if (envPy && existsSync(envPy)) {
        pythonCmd = envPy;
        console.log(chalk.blue('✓ Using Python from XYZTOOLS_PYTHON'));
      } else {
        let pyenvPython = null;
        try {
          const pyenvShim = execSync('which python3', { encoding: 'utf-8' }).trim();
          if (pyenvShim.includes('.pyenv/shims')) {
            pyenvPython = pyenvShim;
          }
        } catch (e) {
          // pyenv not found or python3 not in path
        }

        if (existsSync(venvPython3)) {
          pythonCmd = venvPython3;
          console.log(chalk.blue('✓ Using virtual environment Python (whisper-env)'));
          if (pyenvPython) {
            console.log(chalk.blue(`   (venv uses pyenv Python: ${pyenvPython})`));
          }
        } else if (existsSync(venvPython)) {
          pythonCmd = venvPython;
          console.log(chalk.blue('✓ Using virtual environment Python (whisper-env)'));
          if (pyenvPython) {
            console.log(chalk.blue(`   (venv uses pyenv Python: ${pyenvPython})`));
          }
        } else if (pyenvPython) {
          pythonCmd = pyenvPython;
          console.log(chalk.blue(`✓ Using pyenv Python: ${pyenvPython}`));
        } else {
          try {
            execSync('which python3', { stdio: 'ignore' });
            pythonCmd = 'python3';
            console.log(chalk.yellow('⚠️  Virtual environment not found, using system Python'));
            console.log(chalk.yellow('💡 For best results, run: ./setup.sh to create whisper-env'));
          } catch (e) {
            const msg = 'python3 not found. Whisper requires Python. Install Python 3.12 via pyenv and run ./setup.sh';
            console.log(chalk.red(`❌ Error: ${msg}`));
            throw new Error(msg);
          }
        }
      }

      const whisperArgs = [whisperScriptPath, url];
      if (mdOnly) {
        whisperArgs.push(
          '-o',
          path.join(jobDir, `${fileBase}.md`),
          '-f',
          'markdown',
          '--video-title',
          videoInfo.title
        );
      } else {
        whisperArgs.push('-o', path.join(jobDir, `${fileBase}.txt`), '-f', 'timestamped');
        if (exportMd) {
          whisperArgs.push('--also-markdown', '--video-title', videoInfo.title);
        }
      }
      execFileSync(pythonCmd, whisperArgs, { stdio: 'inherit', env: childEnv });
      console.log(chalk.green('✅ Transcript generation completed'));
    } catch (e) {
      console.log(chalk.red(`❌ Error running whisper_transcribe.py: ${e.message}`));
      console.log(
        chalk.yellow(
          '\n💡 Caption transcripts (index.js) do not need Whisper. Whisper is only for videos without captions.'
        )
      );
      console.log(chalk.yellow('💡 Install Whisper on this Mac, then retry:'));
      console.log(chalk.white('   pip install -U openai-whisper'));
      console.log(chalk.white('   Or from the repo root: ./setup.sh (creates whisper-env)'));
      throw e;
    }
  } else {
    const msg = 'Neither index.js nor whisper_transcribe.py found under project root';
    console.log(chalk.red(`❌ Error: ${msg}`));
    console.log(chalk.yellow('💡 Make sure YTTOOL_ROOT points at the repository root'));
    throw new Error(msg);
  }
}

/**
 * Transcript for a single video or every video in a playlist URL.
 */
function convertToTxt(url, outputRootDir = null) {
  console.log('📝 Converting to text transcript...');

  const playlist = getPlaylistInfo(url);
  const videoUrls = playlist ? playlistVideoUrls(playlist) : [];

  if (playlist && videoUrls.length > 0) {
    console.log(chalk.blue(`📚 Playlist: ${playlist.title}`));
    console.log(chalk.blue(`📊 Transcribing ${videoUrls.length} videos (one folder per video)…\n`));
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < videoUrls.length; i++) {
      const videoUrl = videoUrls[i];
      console.log(chalk.cyan(`\n${'='.repeat(60)}`));
      console.log(chalk.cyan(`📹 Video ${i + 1}/${videoUrls.length}`));
      console.log(chalk.cyan(`${'='.repeat(60)}\n`));
      try {
        convertToTxtOneVideo(videoUrl, outputRootDir);
        ok++;
      } catch (e) {
        fail++;
        console.log(chalk.red(`❌ Video ${i + 1} failed: ${e.message}`));
      }
    }
    console.log(chalk.cyan(`\n${'='.repeat(60)}`));
    if (fail === 0) {
      console.log(chalk.green(`✅ Playlist transcripts complete (${ok}/${videoUrls.length})`));
    } else {
      console.log(
        chalk.yellow(`⚠️  Playlist transcripts finished: ${ok} succeeded, ${fail} failed (${videoUrls.length} total)`)
      );
      if (ok === 0) {
        throw new Error(`All ${fail} transcript jobs failed`);
      }
    }
    return;
  }

  convertToTxtOneVideo(url, outputRootDir);
}

/**
 * Prompt user for format choice
 */
async function promptFormatChoice() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve, reject) => {
    console.log('\n📋 What would you like to convert to?');
    console.log('  1. mp3 - Single video to MP3');
    console.log('  2. mp3-playlist - Entire playlist to MP3');
    console.log('  3. txt - Video transcript (using existing tool)');
    console.log('  4. md - Transcript only as Markdown (same pipeline as txt)');
    console.log();
    
    rl.question('Enter choice (1-4): ', (answer) => {
      rl.close();
      const choice = answer.trim();
      const choiceMap = {
        '1': 'mp3',
        '2': 'mp3-playlist',
        '3': 'txt',
        '4': 'md',
      };
      
      const format = choiceMap[choice];
      if (!format) {
        console.log(chalk.red('❌ Invalid choice'));
        process.exit(1);
      }
      resolve(format);
    });
  });
}

/**
 * Main function
 */
async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 convert <url> [options]')
    .command('convert <url>', 'Convert YouTube video/playlist', (yargs) => {
      yargs
        .positional('url', {
          describe: 'YouTube video or playlist URL',
          type: 'string',
        })
        .option('format', {
          alias: 'f',
          type: 'string',
          choices: ['mp3', 'mp3-playlist', 'txt', 'md'],
          describe: 'Output format (if not specified, will prompt)',
        })
        .option('output', {
          alias: 'o',
          type: 'string',
          describe: 'Output directory (default: current directory)',
        })
    })
    .help()
    .alias('help', 'h')
    .version('1.0.0')
    .alias('version', 'v')
    .argv;
  
  if (argv._[0] !== 'convert' || !argv.url) {
    yargs.showHelp();
    process.exit(1);
  }
  
  // Sanitize URL
  const sanitizedUrl = sanitizeUrl(argv.url);
  if (sanitizedUrl !== argv.url) {
    console.log(chalk.yellow('🔧 Sanitized URL (removed escape characters)'));
  }
  
  // Determine format
  let formatChoice = argv.format;
  
  if (!formatChoice) {
    formatChoice = await promptFormatChoice();
  }
  
  // Execute conversion
  const outputDir = argv.output || null;
  
  if (formatChoice === 'mp3') {
    convertToMp3(sanitizedUrl, outputDir);
  } else if (formatChoice === 'mp3-playlist') {
    convertPlaylistToMp3(sanitizedUrl, outputDir);
  } else if (formatChoice === 'txt') {
    convertToTxt(sanitizedUrl, outputDir);
  } else if (formatChoice === 'md') {
    const prevMd = process.env.XYZTOOLS_EXPORT_MD;
    const prevOnly = process.env.XYZTOOLS_MD_ONLY;
    process.env.XYZTOOLS_EXPORT_MD = '1';
    process.env.XYZTOOLS_MD_ONLY = '1';
    try {
      convertToTxt(sanitizedUrl, outputDir);
    } finally {
      if (prevMd === undefined) delete process.env.XYZTOOLS_EXPORT_MD;
      else process.env.XYZTOOLS_EXPORT_MD = prevMd;
      if (prevOnly === undefined) delete process.env.XYZTOOLS_MD_ONLY;
      else process.env.XYZTOOLS_MD_ONLY = prevOnly;
    }
  } else {
    console.log(chalk.red(`❌ Unknown format: ${formatChoice}`));
    process.exit(1);
  }
}

function isExecutedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

export {
  sanitizeUrl,
  checkYtDlp,
  getOutputDir,
  getVideoInfo,
  getPlaylistInfo,
  convertToMp3,
  convertPlaylistToMp3,
  convertToTxt,
  prepareJobOutput,
  sanitizeForFsName,
  PACKAGE_ROOT,
};

if (isExecutedAsCli()) {
  main().catch((error) => {
    console.error(chalk.red(`❌ Error: ${error.message}`));
    process.exit(1);
  });
}

