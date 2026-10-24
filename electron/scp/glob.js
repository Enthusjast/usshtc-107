'use strict';

const DEFAULT_GLOB_LIMITS = Object.freeze({ maxPatternLength: 4096, maxTokens: 256, maxNameLength: 4096 });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function globError(message) {
  const error = new Error(message);
  error.code = 'SCP_INVALID_GLOB';
  return error;
}

function optionsWithLimits(options) {
  const result = { ...DEFAULT_GLOB_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_GLOB_LIMITS)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > DEFAULT_GLOB_LIMITS[key]) {
      throw globError('Invalid SCP glob limit');
    }
  }
  return result;
}

function parsePattern(pattern, options) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > options.maxPatternLength
      || !pattern.isWellFormed() || pattern.includes('/') || CONTROL.test(pattern)) {
    throw globError('Invalid SCP glob pattern');
  }
  const chars = Array.from(pattern);
  const tokens = [];
  let magic = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === '\\') {
      if (++i === chars.length) throw globError('Unterminated SCP glob escape');
      tokens.push({ type: 'literal', value: chars[i] });
    } else if (char === '*') {
      if (tokens.at(-1)?.type === 'star') throw globError('Recursive SCP globbing is not supported');
      magic = true;
      tokens.push({ type: 'star' });
    } else if (char === '?') {
      magic = true;
      tokens.push({ type: 'any' });
    } else if (char === '[') {
      magic = true;
      let cursor = i + 1;
      const negative = chars[cursor] === '!' || chars[cursor] === '^';
      if (negative) cursor += 1;
      const members = [];
      if (chars[cursor] === ']') members.push({ value: chars[cursor++], escaped: false });
      while (cursor < chars.length && chars[cursor] !== ']') {
        let value = chars[cursor++];
        let escaped = false;
        if (value === '\\') {
          if (cursor === chars.length) throw globError('Unterminated SCP glob escape');
          value = chars[cursor++];
          escaped = true;
        }
        members.push({ value, escaped });
      }
      if (chars[cursor] !== ']' || members.length === 0) throw globError('Unterminated or empty SCP glob class');
      const ranges = [];
      for (let member = 0; member < members.length; member += 1) {
        const start = members[member].value.codePointAt(0);
        if (member + 2 < members.length && members[member + 1].value === '-' && !members[member + 1].escaped) {
          const end = members[member + 2].value.codePointAt(0);
          if (end < start) throw globError('Reversed SCP glob range');
          ranges.push([start, end]);
          member += 2;
        } else ranges.push([start, start]);
      }
      tokens.push({ type: 'class', negative, ranges });
      i = cursor;
    } else {
      tokens.push({ type: 'literal', value: char });
    }
    if (tokens.length > options.maxTokens) throw globError('SCP glob is too complex');
  }
  return { tokens, magic };
}

// Returns an immutable matcher with test(name). Dynamic programming avoids regex
// backtracking; work is bounded by the configured pattern and name limits.
function compileGlob(pattern, options = {}) {
  const bounds = optionsWithLimits(options);
  const { tokens, magic } = parsePattern(pattern, bounds);
  return Object.freeze({
    magic,
    test(name) {
      if (typeof name !== 'string' || !name || name.length > bounds.maxNameLength || !name.isWellFormed()
          || name.includes('/') || CONTROL.test(name) || name === '.' || name === '..') return false;
      // Match shell glob semantics: a leading period must be explicit, so '*'
      // does not unexpectedly copy hidden credentials or retained staging files.
      if (name.startsWith('.') && !(tokens[0]?.type === 'literal' && tokens[0].value === '.')) return false;
      const chars = Array.from(name);
      let previous = new Uint8Array(chars.length + 1);
      let next = new Uint8Array(chars.length + 1);
      previous[0] = 1;
      for (const token of tokens) {
        next.fill(0);
        if (token.type === 'star') next[0] = previous[0];
        for (let i = 1; i <= chars.length; i += 1) {
          if (token.type === 'star') next[i] = previous[i] || next[i - 1];
          else if (previous[i - 1]) {
            const char = chars[i - 1];
            if (token.type === 'any' || (token.type === 'literal' && token.value === char)) next[i] = 1;
            else if (token.type === 'class') {
              const code = char.codePointAt(0);
              const included = token.ranges.some(([start, end]) => code >= start && code <= end);
              next[i] = Number(token.negative ? !included : included);
            }
          }
        }
        const swap = previous;
        previous = next;
        next = swap;
      }
      return Boolean(previous[chars.length]);
    },
  });
}

function hasGlobMagic(pattern, options = {}) {
  const bounds = optionsWithLimits(options);
  return parsePattern(pattern, bounds).magic;
}

function matchGlob(pattern, name, options = {}) {
  return compileGlob(pattern, options).test(name);
}

module.exports = { compileGlob, hasGlobMagic, matchGlob, DEFAULT_GLOB_LIMITS };
