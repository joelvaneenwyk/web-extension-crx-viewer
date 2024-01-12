/* jshint node:true */
/* globals cp, ls, mkdir, test */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { mkdir, cp, ls } from 'shelljs';

interface Setup {
  defines: Map<string, boolean | string>,
  mkdirs: string[],
  copy: string[][],
  preprocess: string[][],
  build_dir?: string,
  preprocessCSS?: any
}

/**
 * A simple preprocessor that is based on the Firefox preprocessor
 * (https://dxr.mozilla.org/mozilla-central/source/build/docs/preprocessor.rst).
 * The main difference is that this supports a subset of the commands and it
 * supports preprocessor commands in HTML-style comments.
 *
 * Currently supported commands:
 * - if
 * - elif
 * - else
 * - endif
 * - include
 * - expand
 * - error
 *
 * Every #if must be closed with an #endif. Nested conditions are supported.
 *
 * Within an #if or #else block, one level of comment tokens is stripped. This
 * allows us to write code that can run even without preprocessing. For example:
 *
 * //#if SOME_RARE_CONDITION
 * // // Decrement by one
 * // --i;
 * //#else
 * // // Increment by one.
 * ++i;
 * //#endif
 */
export function preprocess(inFilename: string, outFilename: string, defines: Map<string, string>) {
  // TODO make this really read line by line.
  const lines = fs.readFileSync(inFilename).toString().split('\n')
  const totalLines = lines.length
  let out = ''
  let i = 0
  function readLine() {
    if (i < totalLines) {
      return lines[i++]
    }
    return null
  }
  const writeLine = (typeof outFilename === 'function'
    ? outFilename
    : function (line: string) {
      out += line + '\n'
    })
  function evaluateCondition(code: string) {
    if (!code?.trim()) {
      throw new Error('No JavaScript expression given at ' + loc())
    }
    try {
      return vm.runInNewContext(code, defines, { displayErrors: false })
    } catch (e) {
      throw new Error('Could not evaluate "' + code + '" at ' + loc() + '\n' +
        e.name + ': ' + e.message)
    }
  }
  function include(file: string) {
    const realPath = fs.realpathSync(inFilename)
    const dir = path.dirname(realPath)
    try {
      let fullpath
      if (file.indexOf('$ROOT/') === 0) {
        fullpath = path.join(__dirname, '../..',
          file.substring('$ROOT/'.length))
      } else {
        fullpath = path.join(dir, file)
      }
      preprocess(fullpath, writeLine, defines)
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error('Failed to include "' + file + '" at ' + loc())
      }
      throw e // Some other error
    }
  }
  function expand(line: string): string {
    line = line.replace(/__[\w]+__/g, function (variable: string) {
      const variable_name: string = variable.substring(2, variable.length - 2)
      if (variable_name in defines) {
        return defines[variable_name]
      }
      return ''
    })
    writeLine(line)
  }

  // not inside if or else (process lines)
  const STATE_NONE = 0
  // inside if, condition false (ignore until #else or #endif)
  const STATE_IF_FALSE = 1
  // inside else, #if was false, so #else is true (process lines until #endif)
  const STATE_ELSE_TRUE = 2
  // inside if, condition true (process lines until #else or #endif)
  const STATE_IF_TRUE = 3
  // inside else or elif, #if/#elif was true, so following #else or #elif is
  // false (ignore lines until #endif)
  const STATE_ELSE_FALSE = 4

  let line: string
  let state: number = STATE_NONE
  const stack: number[] = []
  const control =
    /* jshint -W101 */
    /^(?:\/\/|<!--)\s*#(if|elif|else|endif|expand|include|error)\b(?:\s+(.*?)(?:-->)?$)?/
  /* jshint +W101 */
  let lineNumber: number = 0
  var loc = function () {
    return fs.realpathSync(inFilename) + ':' + lineNumber
  }
  while ((line = readLine()) !== null) {
    ++lineNumber
    const m = control.exec(line)
    if (m) {
      switch (m[1]) {
        case 'if':
          stack.push(state)
          state = evaluateCondition(m[2]) ? STATE_IF_TRUE : STATE_IF_FALSE
          break
        case 'elif':
          if (state === STATE_IF_TRUE || state === STATE_ELSE_FALSE) {
            state = STATE_ELSE_FALSE
          } else if (state === STATE_IF_FALSE) {
            state = evaluateCondition(m[2]) ? STATE_IF_TRUE : STATE_IF_FALSE
          } else if (state === STATE_ELSE_TRUE) {
            throw new Error('Found #elif after #else at ' + loc())
          } else {
            throw new Error('Found #elif without matching #if at ' + loc())
          }
          break
        case 'else':
          if (state === STATE_IF_TRUE || state === STATE_ELSE_FALSE) {
            state = STATE_ELSE_FALSE
          } else if (state === STATE_IF_FALSE) {
            state = STATE_ELSE_TRUE
          } else {
            throw new Error('Found #else without matching #if at ' + loc())
          }
          break
        case 'endif':
          if (state === STATE_NONE) {
            throw new Error('Found #endif without #if at ' + loc())
          }
          state = stack.pop()
          break
        case 'expand':
          if (state !== STATE_IF_FALSE && state !== STATE_ELSE_FALSE) {
            expand(m[2])
          }
          break
        case 'include':
          if (state !== STATE_IF_FALSE && state !== STATE_ELSE_FALSE) {
            include(m[2])
          }
          break
        case 'error':
          if (state !== STATE_IF_FALSE && state !== STATE_ELSE_FALSE) {
            throw new Error('Found #error ' + m[2] + ' at ' + loc())
          }
          break
      }
    } else {
      if (state === STATE_NONE) {
        writeLine(line)
      } else if ((state === STATE_IF_TRUE || state === STATE_ELSE_TRUE) &&
        !stack.includes(STATE_IF_FALSE) &&
        !stack.includes(STATE_ELSE_FALSE)) {
        writeLine(line.replace(/^\/\/|^<!--|-->$/g, '  '))
      }
    }
  }
  if (state !== STATE_NONE || stack.length !== 0) {
    throw new Error('Missing #endif in preprocessor for ' +
      fs.realpathSync(inFilename))
  }
  if (typeof outFilename !== 'function') {
    fs.writeFileSync(outFilename, out)
  }
}

const deprecatedInMozcentral = new RegExp('(^|\\W)(' + [
  '-moz-box-sizing',
  '-moz-grab',
  '-moz-grabbing'
].join('|') + ')')

export function preprocessCSS(mode: string, source: string, destination: string) {
  function hasPrefixedFirefox(line) {
    return (/(^|\W)-(ms|o|webkit)-\w/.test(line))
  }

  function hasPrefixedMozcentral(line) {
    return (/(^|\W)-(ms|o|webkit)-\w/.test(line) ||
      deprecatedInMozcentral.test(line))
  }

  function expandImports(content, baseUrl) {
    return content.replace(/^\s*@import\s+url\(([^\)]+)\);\s*$/gm,
      function (all, url) {
        const file = path.join(path.dirname(baseUrl), url)
        const imported = fs.readFileSync(file, 'utf8').toString()
        return expandImports(imported, file)
      })
  }

  function removePrefixed(content: string, hasPrefixedFilter) {
    const lines = content.split(/\r?\n/g)
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!hasPrefixedFilter(line)) {
        i++
        continue
      }
      if (/\{\s*$/.test(line)) {
        let bracketLevel = 1
        let j = i + 1
        while (j < lines.length && bracketLevel > 0) {
          const checkBracket = /([{}])\s*$/.exec(lines[j])
          if (checkBracket) {
            if (checkBracket[1] === '{') {
              bracketLevel++
            } else if (lines[j].indexOf('{') < 0) {
              bracketLevel--
            }
          }
          j++
        }
        lines.splice(i, j - i)
      } else if (/[};]\s*$/.test(line)) {
        lines.splice(i, 1)
      } else {
        // multiline? skipping until next directive or bracket
        do {
          lines.splice(i, 1)
        } while (i < lines.length &&
        !/\}\s*$/.test(lines[i]) &&
          lines[i].indexOf(':') < 0)
        if (i < lines.length && /\S\s*}\s*$/.test(lines[i])) {
          lines[i] = lines[i].substr(lines[i].indexOf('}'))
        }
      }
      // collapse whitespace
      while (lines[i] === '' && lines[i - 1] === '') {
        lines.splice(i, 1)
      }
    }
    return lines.join('\n')
  }

  if (!mode) {
    throw new Error('Invalid CSS preprocessor mode')
  }

  let content = fs.readFileSync(source, 'utf8').toString()
  content = expandImports(content, source)
  if (mode === 'mozcentral' || mode === 'firefox') {
    content = removePrefixed(content, mode === 'mozcentral'
      ? hasPrefixedMozcentral
      : hasPrefixedFirefox)
  }
  fs.writeFileSync(destination, content)
}

/**
 * Simplifies common build steps.
 * @param {object} setup
 *        .defines defines for preprocessors
 *        .mkdirs array of directories to be created before copying/processing.
 *        .copy array of arrays of source and destination pairs of files to copy
 *        .preprocess array of arrays of source and destination pairs of files
 *                    run through preprocessor.
 */
export function build(setup: Setup) {
  const defines = setup.defines;

  (setup.mkdirs || []).forEach(function (directory) {
    mkdir('-p', directory)
  })

  setup.copy.forEach(function (option) {
    const source = option[0]
    const destination = option[1]
    cp('-R', source, destination)
  })

  setup.preprocess.forEach(function (option) {
    let sources = option[0]
    const destination = option[1]

    sources = ls('-R', sources)
    sources.forEach(function (source) {
      // ??? Warn if the source is wildcard and dest is file?
      let destWithFolder = destination
      if (test('-d', destination)) {
        destWithFolder += '/' + path.basename(source)
      }
      preprocess(source, destWithFolder, defines)
    })
  });

  (setup.preprocessCSS || []).forEach(function (option) {
    const mode = option[0]
    const source = option[1]
    const destination = option[2]
    preprocessCSS(mode, source, destination)
  })
}

/**
 * Merge two defines arrays. Values in the second param will override values in
 * the first.
 */
export function merge(defaults: Map<string, any>, defines: Map<string, any>) {
  const ret = {}
  for (var key in defaults) {
    ret[key] = defaults[key]
  }
  for (key in defines) {
    ret[key] = defines[key]
  }
  return ret
}
