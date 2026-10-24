'use strict';

const MAX_COMMAND_BYTES = 32 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function invalid(error) {
  return { invalid: true, code: 'SCP_INVALID_COMMAND', error };
}

function isScpExecutable(value) {
  return value === 'scp' || /^\/(?:[^/]+\/)*scp$/u.test(value);
}

// Only tokenization is performed: this module never invokes a shell or expands a path.
function tokenize(command, withPatterns = false) {
  const words = [];
  let word = '';
  let globPattern = '';
  const append = (char, literal) => {
    word += char;
    globPattern += char === '\\' || (literal && '*?[]'.includes(char)) ? `\\${char}` : char;
  };
  let started = false;
  let quote = null;
  const finish = () => {
    if (started) words.push(withPatterns ? { word, globPattern } : word);
    word = '';
    globPattern = '';
    started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else append(char, true);
      continue;
    }
    if (char === '\\') {
      if (i + 1 === command.length) throw new Error('Unterminated escape');
      const next = command[++i];
      // In double quotes, a backslash only escapes shell-special characters.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) append('\\', true);
      append(next, true);
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`') throw new Error('Shell expansion is not supported');
      else append(char, true);
      continue;
    }
    if (char === ' ' || char === '\t') {
      finish();
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else {
      if (';&|<>(){}$`'.includes(char) || (char === '~' && !started) || (char === '#' && !started)) {
        throw new Error('Shell operators and expansion are not supported');
      }
      append(char, false);
      started = true;
    }
  }
  if (quote) throw new Error('Unterminated quote');
  finish();
  return words;
}

function parseScpCommand(command) {
  if (typeof command !== 'string') return null;
  // Identify the executable separately, so a malformed SCP argument cannot fall through
  // to the general-purpose exec bridge. Non-SCP command syntax is left untouched.
  const prefix = command.match(/^\s*((?:[^\s'"\\;|&<>]|\\.|'[^']*'|"[^"]*")+)/u)?.[1];
  let recognized = false;
  if (prefix) {
    try { recognized = isScpExecutable(tokenize(prefix)[0]); } catch { /* Not an SCP executable. */ }
  }
  if (!recognized) return null;
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return invalid('SCP command exceeds the size limit');
  // Tabs delimit arguments; all other control characters, including newlines, are forbidden.
  if (CONTROL.test(command.replaceAll('\t', '')) || !command.isWellFormed()) return invalid('Invalid command characters');
  let words;
  try { words = tokenize(command, true); } catch (error) { return invalid(error.message); }
  if (!isScpExecutable(words[0]?.word)) return null;
  let direction = null;
  let recursive = false;
  let preserve = false;
  let targetDirectory = false;
  let options = true;
  const paths = [];
  for (const token of words.slice(1)) {
    const { word } = token;
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-') && word !== '-') {
      for (const flag of word.slice(1)) {
        if (flag === 'f' || flag === 't') {
          const next = flag === 'f' ? 'source' : 'sink';
          if (direction && direction !== next) return invalid('Conflicting SCP directions');
          direction = next;
        } else if (flag === 'r') recursive = true;
        else if (flag === 'p') preserve = true;
        else if (flag === 'd') targetDirectory = true;
        else if (flag !== 'v' && flag !== 'q') return invalid('Unsupported SCP option');
      }
    } else {
      options = false;
      paths.push(token);
    }
  }
  if (!direction) return invalid('SCP requires exactly one remote direction');
  if (paths.length !== 1 || !paths[0].word) return invalid('SCP requires exactly one nonempty path');
  const { word: path, globPattern } = paths[0];
  if (CONTROL.test(path)) return invalid('Invalid path characters');
  // A colon before any slash is a remote specification, including user@host:path
  // and bracketed IPv6 hosts. An explicit ./ or absolute path disambiguates a colon.
  if (/^[^/]*:/u.test(path) || /^scp:\/\//iu.test(path)) return invalid('Remote-to-remote SCP is not supported');
  const result = { direction, path, recursive, preserve, targetDirectory };
  if (direction === 'source') result.globPattern = globPattern;
  return result;
}

module.exports = { parseScpCommand, MAX_COMMAND_BYTES };
