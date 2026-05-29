/**
 * Efficient Labs Sovereign StratosAgent Ingestion Bridge
 * Safely parses legacy agent scripts (e.g. OpenClaw, Playwright) using an AST-based analyzer.
 * GUARANTEE: Never executes or evaluates the input script. Pure lexical syntax translation.
 */

/**
 * Lightweight Lexer Token types.
 */
const TOKEN_TYPES = {
  IDENTIFIER: 'IDENTIFIER',
  STRING: 'STRING',
  PUNCTUATION: 'PUNCTUATION',
  NUMBER: 'NUMBER'
};

/**
 * Tokenizes a raw script string.
 */
function lex(scriptStr) {
  const tokens = [];
  let i = 0;
  const len = scriptStr.length;

  while (i < len) {
    const char = scriptStr[i];

    // 1. Skip Whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // 2. Skip single-line comments
    if (char === '/' && scriptStr[i + 1] === '/') {
      i += 2;
      while (i < len && scriptStr[i] !== '\n') {
        i++;
      }
      continue;
    }

    // 3. Skip multi-line comments
    if (char === '/' && scriptStr[i + 1] === '*') {
      i += 2;
      while (i < len && !(scriptStr[i] === '*' && scriptStr[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    // 4. Match String Literals
    if (char === '"' || char === "'" || char === '`') {
      const quoteChar = char;
      let strVal = '';
      i++; // Skip start quote
      while (i < len && scriptStr[i] !== quoteChar) {
        if (scriptStr[i] === '\\') {
          strVal += scriptStr[i + 1];
          i += 2;
        } else {
          strVal += scriptStr[i];
          i++;
        }
      }
      i++; // Skip end quote
      tokens.push({ type: TOKEN_TYPES.STRING, value: strVal });
      continue;
    }

    // 5. Match Punctuation
    if (/[;.,(){}[\]:]/.test(char)) {
      tokens.push({ type: TOKEN_TYPES.PUNCTUATION, value: char });
      i++;
      continue;
    }

    // 6. Match Numbers
    if (/\d/.test(char)) {
      let numStr = '';
      while (i < len && /\d/.test(scriptStr[i])) {
        numStr += scriptStr[i];
        i++;
      }
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: parseInt(numStr, 10) });
      continue;
    }

    // 7. Match Identifiers
    if (/[a-zA-Z_$]/.test(char)) {
      let identStr = '';
      while (i < len && /[a-zA-Z0-9_$]/.test(scriptStr[i])) {
        identStr += scriptStr[i];
        i++;
      }
      tokens.push({ type: TOKEN_TYPES.IDENTIFIER, value: identStr });
      continue;
    }

    // Skip unknown symbols
    i++;
  }

  return tokens;
}

/**
 * Standardizes syntax nodes.
 * Traverses tokens to extract function calls:
 * e.g., click('#selector'), page.goto("url"), or state("login", { ... })
 */
function parseAST(tokens) {
  const expressions = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    // Detect function calls: either IDENTIFIER(args...) or IDENTIFIER.IDENTIFIER(args...)
    if (token.type === TOKEN_TYPES.IDENTIFIER) {
      let targetName = token.value;
      let next = tokens[i + 1];

      // Handle obj.method calls (e.g. page.click)
      if (next && next.type === TOKEN_TYPES.PUNCTUATION && next.value === '.') {
        const methodToken = tokens[i + 2];
        if (methodToken && methodToken.type === TOKEN_TYPES.IDENTIFIER) {
          targetName = `${token.value}.${methodToken.value}`;
          i += 2;
          next = tokens[i + 1];
        }
      }

      // Check if this is a function call (followed by '(')
      if (next && next.type === TOKEN_TYPES.PUNCTUATION && next.value === '(') {
        i += 2; // skip name and '('
        const args = [];
        
        // Parse arguments inside parens
        while (i < tokens.length && !(tokens[i].type === TOKEN_TYPES.PUNCTUATION && tokens[i].value === ')')) {
          const argToken = tokens[i];

          if (argToken.type === TOKEN_TYPES.STRING || argToken.type === TOKEN_TYPES.NUMBER) {
            args.push(argToken.value);
            i++;
          } else if (argToken.type === TOKEN_TYPES.PUNCTUATION && argToken.value === '{') {
            // Simple object literal parsing for state configurations
            const objVal = {};
            i++; // skip '{'
            
            while (i < tokens.length && !(tokens[i].type === TOKEN_TYPES.PUNCTUATION && tokens[i].value === '}')) {
              const keyToken = tokens[i];
              if (keyToken.type === TOKEN_TYPES.IDENTIFIER || keyToken.type === TOKEN_TYPES.STRING) {
                const colon = tokens[i + 1];
                const valToken = tokens[i + 2];
                if (colon && colon.value === ':' && valToken) {
                  objVal[keyToken.value] = valToken.value;
                  i += 3;
                } else {
                  i++;
                }
              } else {
                i++;
              }
              // Skip trailing commas or spacing punctuation inside object
              if (tokens[i] && tokens[i].type === TOKEN_TYPES.PUNCTUATION && tokens[i].value === ',') {
                i++;
              }
            }
            i++; // skip '}'
            args.push(objVal);
          } else {
            i++;
          }

          // Skip commas separating function arguments
          if (tokens[i] && tokens[i].type === TOKEN_TYPES.PUNCTUATION && tokens[i].value === ',') {
            i++;
          }
        }
        
        expressions.push({
          type: 'CallExpression',
          callee: targetName,
          arguments: args
        });
      }
    }
    i++;
  }

  return expressions;
}

/**
 * Translates parsed expressions into a clean JSON behavioral execution plan.
 * Map function structures dynamically to target StratosAgent JSON tasks.
 */
export function translateLegacyScript(scriptStr) {
  const tokens = lex(scriptStr);
  const ast = parseAST(tokens);
  
  const stateTransitions = [];
  const steps = [];

  for (const expr of ast) {
    const callee = expr.callee;
    const args = expr.arguments;

    switch (callee) {
      case 'goto':
      case 'page.goto':
        steps.push({
          type: 'goto',
          url: args[0] || ''
        });
        break;

      case 'click':
      case 'page.click':
        steps.push({
          type: 'click',
          target: args[0] || ''
        });
        break;

      case 'fill':
      case 'type':
      case 'page.fill':
      case 'page.type':
        steps.push({
          type: 'fill',
          target: args[0] || '',
          value: args[1] || ''
        });
        break;

      case 'waitFor':
      case 'wait':
      case 'waitForSelector':
      case 'page.waitForSelector':
        steps.push({
          type: 'wait',
          target: args[0] || ''
        });
        break;

      case 'state':
        // State DSL parsing e.g. state("dashboard", { on: "click", target: ".welcome", goto: "finish" })
        const stateName = args[0] || 'anonymous';
        const config = args[1] || {};
        stateTransitions.push({
          state: stateName,
          on: config.on || 'load',
          target: config.target || '',
          goto: config.goto || ''
        });
        break;

      default:
        // Exclude unsupported functions safely or tag them as custom commands
        break;
    }
  }

  return {
    engine: 'StratosAgent-1.0',
    timestamp: new Date().toISOString(),
    steps,
    stateTransitions,
    astLength: ast.length
  };
}
