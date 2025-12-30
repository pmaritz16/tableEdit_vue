/**
 * CSV Editor Server
 * 
 * A Node.js/Express server for managing CSV files with schema validation,
 * data transformation, and rule-based operations.
 * 
 * @module server
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'Data');
const MAIN_LOG = path.join(__dirname, 'main.log');
const COMMANDS_LOG = path.join(DATA_DIR, 'commands.txt');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

/**
 * Ensures the Data directory exists, creating it if necessary.
 * @returns {Promise<void>}
 */
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    await logError('Failed to create data directory', error);
  }
}

/**
 * Logs an action message to main.log with timestamp.
 * @param {string} message - The message to log
 * @returns {Promise<void>}
 */
async function logAction(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  try {
    await fs.appendFile(MAIN_LOG, logEntry);
  } catch (error) {
    console.error('Failed to write to log:', error);
  }
}

/**
 * Logs an error message to main.log with timestamp.
 * @param {string} message - The error message
 * @param {Error|string} error - The error object or message
 * @returns {Promise<void>}
 */
async function logError(message, error) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ERROR: ${message} - ${error?.message || error}\n`;
  try {
    await fs.appendFile(MAIN_LOG, logEntry);
  } catch (err) {
    console.error('Failed to write to log:', err);
  }
}

// Global state
/** @type {Object<string, {schema: Array<{name: string, type: string}>, rows: Array<Object>, originalFile: string}>} */
let tables = {};
/** @type {boolean} */
let commandLoggingEnabled = false;

// ============================================================================
// CSV Parsing Functions
// ============================================================================

/**
 * Parses a CSV line, handling quoted fields and escaped quotes.
 * Supports fields enclosed in double quotes with internal quotes escaped as "".
 * 
 * @param {string} line - The CSV line to parse
 * @returns {Array<string>} Array of field values
 */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote ("")
        current += '"';
        i += 2;
        continue;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
        continue;
      }
    }
    
    if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(current.trim());
      current = '';
      i++;
      continue;
    }
    
    current += char;
    i++;
  }
  
  // Add the last field
  fields.push(current.trim());
  
  return fields;
}

/**
 * Parses the schema line from a CSV file.
 * Format: "columnName:columnType,columnName2:columnType2,..."
 * If no type is specified, defaults to TEXT.
 * 
 * @param {string} firstLine - The first line of the CSV file containing schema
 * @returns {Array<{name: string, type: string}>} Array of column definitions
 */
function parseSchema(firstLine) {
  const columns = parseCSVLine(firstLine);
  const schema = [];
  
  for (const col of columns) {
    const parts = col.split(':');
    const name = parts[0].trim();
    const type = parts.length > 1 ? parts[1].trim().toUpperCase() : 'TEXT';
    schema.push({ name, type });
  }
  
  return schema;
}

/**
 * Cleans a REAL value by removing commas and dollar signs.
 * Used when reading CSV files to prepare numeric values.
 * 
 * @param {string} value - The raw value string
 * @returns {string} Cleaned value string
 */
function cleanRealValue(value) {
  if (typeof value === 'string') {
    return value.replace(/[,$]/g, '');
  }
  return value;
}

/**
 * Parses a value according to its type (TEXT, INT, or REAL).
 * Handles type conversion and default values.
 * 
 * @param {string} value - The raw value string
 * @param {string} type - The column type (TEXT, INT, or REAL)
 * @returns {string|number} Parsed value according to type
 */
function parseValue(value, type) {
  if (value === '' || value === null || value === undefined) {
    switch (type) {
      case 'INT': return 0;
      case 'REAL': return 0.0;
      case 'TEXT': return '';
      default: return '';
    }
  }
  
  switch (type) {
    case 'INT':
      const intVal = parseInt(value, 10);
      return isNaN(intVal) ? 0 : intVal;
    case 'REAL':
      const cleaned = cleanRealValue(String(value));
      const realVal = parseFloat(cleaned);
      return isNaN(realVal) ? 0.0 : realVal;
    case 'TEXT':
      return String(value);
    default:
      return String(value);
  }
}

/**
 * Loads all CSV files from the Data directory.
 * Preserves in-memory tables (like copied tables) that don't have files on disk.
 * 
 * @param {boolean} resetTables - If true, clears all tables before loading
 * @returns {Promise<{success: boolean, tables?: Object, error?: string}>}
 */
async function loadCSVFiles(resetTables = false) {
  await logAction('Loading CSV files from data directory');
  
  // Save in-memory tables that don't have corresponding files
  const inMemoryTables = {};
  if (!resetTables) {
    for (const [name, table] of Object.entries(tables)) {
      // Check if this table has a corresponding file
      const expectedFile = path.join(DATA_DIR, table.originalFile);
      try {
        await fs.access(expectedFile);
        // File exists, will be reloaded from disk
      } catch {
        // File doesn't exist, preserve this in-memory table
        inMemoryTables[name] = table;
      }
    }
  }
  
  // Reset tables if requested, otherwise start with in-memory tables
  if (resetTables) {
    tables = {};
  } else {
    tables = inMemoryTables;
  }
  
  try {
    const files = await fs.readdir(DATA_DIR);
    const csvFiles = files.filter(f => f.toUpperCase().endsWith('.CSV'));
    
    for (const file of csvFiles) {
      const filePath = path.join(DATA_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
      
      if (lines.length === 0) continue;
      
      const schema = parseSchema(lines[0]);
      // Strip .csv/.CSV extension from filename to get table name (case-insensitive)
      const fileName = path.basename(file);
      const tableName = fileName.replace(/\.(csv|CSV)$/i, '');
      const rows = [];
      
      for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        const row = {};
        
        for (let j = 0; j < schema.length; j++) {
          const col = schema[j];
          let value = j < fields.length ? fields[j] : '';
          // Remove surrounding quotes if present
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/""/g, '"');
          }
          value = parseValue(value, col.type);
          row[col.name] = value;
        }
        
        // Truncate extra columns
        rows.push(row);
      }
      
      tables[tableName] = {
        schema,
        rows,
        originalFile: file
      };
      
      await logAction(`Loaded table ${tableName} with ${rows.length} rows`);
    }
    
    return { success: true, tables };
  } catch (error) {
    await logError('Failed to load CSV files', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Expression Evaluator
// ============================================================================

/**
 * Evaluates augmented expressions with support for:
 * - Arithmetic operations (+, -, *, /, ^)
 * - Unary minus (-expression)
 * - Boolean operations (&&, ||, !)
 * - Comparisons (<, =, >, !=)
 * - Conditional expressions (condition ? trueValue : falseValue)
 * - Special functions (BLANK, TODAY, DAY, MONTH, YEAR, NOW, LENGTH, APPEND, UPPER, TOTAL, REGEXP, CURR_ROW, NUM_ROWS)
 * - Field references and constants
 * 
 * @class ExpressionEvaluator
 */
class ExpressionEvaluator {
  constructor(row, tables, currentTable) {
    this.row = row;
    this.tables = tables;
    this.currentTable = currentTable;
  }
  
  evaluate(expression) {
    if (!expression || expression.trim() === '') {
      throw new Error('Empty expression');
    }
    
    try {
      return this._evaluateExpression(expression.trim());
    } catch (error) {
      throw new Error(`Expression evaluation error: ${error.message}`);
    }
  }
  
  _evaluateExpression(expr) {
    expr = expr.trim();
    
    // Handle conditional expressions (find the rightmost ? : pair)
    let questionIndex = -1;
    let colonIndex = -1;
    let depth = 0;
    
    for (let i = expr.length - 1; i >= 0; i--) {
      if (expr[i] === ')') depth++;
      else if (expr[i] === '(') depth--;
      else if (depth === 0) {
        if (expr[i] === ':' && colonIndex === -1) {
          colonIndex = i;
        } else if (expr[i] === '?' && colonIndex !== -1 && questionIndex === -1) {
          questionIndex = i;
          break;
        }
      }
    }
    
    if (questionIndex !== -1 && colonIndex !== -1 && questionIndex < colonIndex) {
      const condition = expr.substring(0, questionIndex).trim();
      const trueExpr = expr.substring(questionIndex + 1, colonIndex).trim();
      const falseExpr = expr.substring(colonIndex + 1).trim();
      const condResult = this._evaluateExpression(condition);
      // Convert to number if it's a string representation of a number
      const numResult = typeof condResult === 'string' ? parseFloat(condResult) : condResult;
      return numResult && numResult !== 0 ? this._evaluateExpression(trueExpr) : this._evaluateExpression(falseExpr);
    }
    
    // Handle function calls FIRST (before parentheses processing)
    // Functions like BLANK(), TODAY(), etc. are processed here
    expr = this._handleFunctions(expr);
    
    // Handle parentheses for grouping sub-expressions
    // This processes nested expressions like (a + b) * (c + d)
    depth = 0;
    let start = -1;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') {
        if (depth === 0) start = i;
        depth++;
      } else if (expr[i] === ')') {
        depth--;
        if (depth === 0 && start !== -1) {
          const inner = expr.substring(start + 1, i);
          const result = this._evaluateExpression(inner);
          expr = expr.substring(0, start) + String(result) + expr.substring(i + 1);
          i = start + String(result).length - 1;
          start = -1;
        }
      }
    }
    
    if (depth !== 0) {
      throw new Error('Mismatched parentheses');
    }
    
    // Handle field references (replace column names with their values)
    // Example: "Price" becomes the actual price value from the current row
    expr = this._handleFieldReferences(expr);
    
    // Handle string literals (single-quoted strings)
    // Example: 'Hello' becomes "Hello" (converted to double quotes for consistency)
    expr = this._handleStringLiterals(expr);
    
    // Handle boolean operations (!, &&, ||)
    // Order: ! (NOT) first, then && (AND), then || (OR)
    expr = this._handleBooleanOps(expr);
    
    // Handle unary minus (-expression)
    expr = this._handleUnaryMinus(expr);
    
    // Handle arithmetic operations (^, *, /, +, -)
    // Order: exponentiation, multiplication/division, addition/subtraction
    // Arithmetic must be processed BEFORE comparisons for correct operator precedence
    expr = this._handleArithmetic(expr);
    
    // Handle comparisons (<, =, >, !=)
    // Returns 1 if true, 0 if false
    // INT and REAL can be compared with each other, TEXT only with TEXT
    // Comparisons are processed AFTER arithmetic so expressions like "a < b - 1" work correctly
    return this._handleComparisons(expr);
  }
  
  _handleFunctions(expr) {
    const functions = {
      'BLANK': (field) => {
        // Field can be a field name string or already evaluated value
        let val;
        if (typeof field === 'string') {
          // If it's a quoted string, extract the content
          if (field.startsWith('"') && field.endsWith('"')) {
            val = field.slice(1, -1);
          } else {
            // Try to get field value by name
            val = this._getFieldValue(field);
            // If field not found, treat the string itself as the value
            if (val === null) {
              val = field;
            }
          }
        } else {
          val = field;
        }
        // Check if blank: empty string, null, undefined, or 0
        const isBlank = (val === '' || val === null || val === undefined || val === 0);
        return isBlank ? 1 : 0;
      },
      'TODAY': () => {
        const now = new Date();
        return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
      },
      'DAY': () => {
        return String(new Date().getDate()).padStart(2, '0');
      },
      'MONTH': () => {
        return String(new Date().getMonth() + 1).padStart(2, '0');
      },
      'YEAR': () => {
        return String(new Date().getFullYear());
      },
      'NOW': () => {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      },
      'LENGTH': (str) => {
        return String(str).length;
      },
      'APPEND': (str1, str2) => {
        return String(str1) + String(str2);
      },
      'UPPER': (str) => {
        return String(str).toUpperCase();
      },
      'TOTAL': (tableName, columnName) => {
        // Get the table and sum all values in the specified column
        if (!tableName || !columnName) {
          return 0;
        }
        
        // Remove quotes if present
        const cleanTableName = typeof tableName === 'string' ? tableName.replace(/^"|"$/g, '') : String(tableName);
        const cleanColumnName = typeof columnName === 'string' ? columnName.replace(/^"|"$/g, '') : String(columnName);
        
        const table = this.tables[cleanTableName];
        if (!table) {
          return 0;
        }
        
        const col = table.schema.find(c => c.name === cleanColumnName);
        if (!col) {
          return 0;
        }
        
        // Sum values based on column type
        let total = 0;
        for (const row of table.rows) {
          const value = row[cleanColumnName];
          if (value !== null && value !== undefined) {
            if (col.type === 'INT' || col.type === 'REAL') {
              const num = parseFloat(value);
              if (!isNaN(num)) {
                total += num;
              }
            }
            // TEXT columns are ignored (total remains 0)
          }
        }
        
        return total;
      },
      'REGEXP': (pattern, str) => {
        // Apply regular expression pattern to string, return first match or ''
        if (!pattern || !str) {
          return '';
        }
        
        // Remove quotes if present
        const cleanPattern = typeof pattern === 'string' ? pattern.replace(/^"|"$/g, '') : String(pattern);
        const cleanStr = typeof str === 'string' ? str.replace(/^"|"$/g, '') : String(str);
        
        try {
          const regex = new RegExp(cleanPattern);
          const match = cleanStr.match(regex);
          return match ? match[0] : '';
        } catch (error) {
          // Invalid regex pattern, return empty string
          return '';
        }
      },
      'CURR_ROW': () => {
        // Returns the index (0-based) of the current row in the table
        if (!this.row || !this.currentTable) {
          return 0;
        }
        
        const table = this.tables[this.currentTable];
        if (!table) {
          return 0;
        }
        
        // Find the current row index by comparing row objects
        // First try reference equality (fastest)
        const index = table.rows.indexOf(this.row);
        if (index !== -1) {
          return index;
        }
        
        // If not found by reference, try to find by comparing all field values
        for (let i = 0; i < table.rows.length; i++) {
          const row = table.rows[i];
          let matches = true;
          for (const col of table.schema) {
            if (row[col.name] !== this.row[col.name]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            return i;
          }
        }
        
        // Row not found, return 0
        return 0;
      },
      'NUM_ROWS': () => {
        // Returns the number of rows in the current table
        if (!this.currentTable) {
          return 0;
        }
        
        const table = this.tables[this.currentTable];
        if (!table) {
          return 0;
        }
        
        return table.rows.length;
      }
    };
    
    // Process functions from innermost to outermost
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      
      for (const [funcName, func] of Object.entries(functions)) {
        // Match function calls - handle both with and without arguments
        // Pattern: FUNC_NAME(optional_args) - case insensitive, word boundary before function name
        const regex = new RegExp(`\\b${funcName}\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'gi');
        let foundMatch = false;
        const newExpr = expr.replace(regex, (match, args) => {
          foundMatch = true;
          changed = true;
          // Handle empty arguments (like TODAY())
          const trimmedArgs = args ? args.trim() : '';
          const argList = trimmedArgs ? this._parseFunctionArgs(trimmedArgs) : [];
          const result = func(...argList);
          return typeof result === 'string' ? `"${result}"` : String(result);
        });
        if (foundMatch && newExpr !== expr) {
          expr = newExpr;
          break;
        }
      }
    }
    
    return expr;
  }
  
  _parseFunctionArgs(args) {
    // Parse function arguments, handling nested parentheses and commas
    const result = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < args.length; i++) {
      const char = args[i];
      
      if ((char === '"' || char === "'") && (i === 0 || args[i-1] !== '\\')) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
          stringChar = '';
        }
        current += char;
      } else if (!inString) {
        if (char === '(') {
          depth++;
          current += char;
        } else if (char === ')') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    }
    if (current.trim()) result.push(current.trim());
    
    return result.map(arg => {
      const trimmedArg = typeof arg === 'string' ? arg.trim() : String(arg);
      
      // If it's a simple field name (identifier, not quoted, not a number, not an expression)
      if (trimmedArg.match(/^[A-Za-z_][A-Za-z0-9_]*$/) && !trimmedArg.startsWith('"')) {
        // Try to get field value directly
        const fieldValue = this._getFieldValue(trimmedArg);
        if (fieldValue !== null && fieldValue !== undefined) {
          return fieldValue;
        }
      }
      
      // Try to evaluate as expression, or return as string
      try {
        const evaluated = this._evaluateExpression(trimmedArg);
        return evaluated;
      } catch {
        // If evaluation fails, return the argument as-is
        return trimmedArg;
      }
    });
  }
  
  _handleFieldReferences(expr) {
    // Replace field references with their values
    // First, protect string literals and already processed values
    const protectedValues = [];
    let protectedIndex = 0;
    
    // Protect quoted strings
    expr = expr.replace(/"([^"]*)"/g, (match) => {
      const key = `__PROTECTED_${protectedIndex}__`;
      protectedValues[protectedIndex] = match;
      protectedIndex++;
      return key;
    });
    
    // Handle field references with offsets: columnName[offset]
    // This must be done BEFORE protecting numbers, so brackets are still visible
    // Pattern: columnName[offset] where offset can be an expression
    // Process from right to left to handle nested brackets correctly
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      
      // Match columnName[offset] pattern
      // The offset can contain brackets, so we need to match balanced brackets
      // Find the rightmost [ that's not part of a protected value
      // When searching backwards: ] means we need to find its opening [, [ means we found an opening
      let bracketStart = -1;
      let bracketDepth = 0;
      for (let i = expr.length - 1; i >= 0; i--) {
        // Skip if we're inside a protected value placeholder
        if (expr.substring(Math.max(0, i - 15), i + 1).includes('__PROTECTED_')) {
          continue;
        }
        
        if (expr[i] === ']') {
          // Closing bracket when searching backwards - we need to find its opening
          bracketDepth++;
        } else if (expr[i] === '[') {
          if (bracketDepth > 0) {
            // Found the opening bracket for a closing bracket we saw
            bracketDepth--;
            if (bracketDepth === 0) {
              // This is the outermost opening bracket we want
              bracketStart = i;
              break;
            }
          }
          // If bracketDepth is 0, this [ doesn't have a matching ], skip it
        }
      }
      
      if (bracketStart === -1) {
        break; // No more indexed fields
      }
      
      // Find the field name before the bracket
      const beforeBracket = expr.substring(0, bracketStart);
      const fieldNameMatch = beforeBracket.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (!fieldNameMatch) {
        break; // Not a field reference
      }
      
      const fieldName = fieldNameMatch[1];
      const fieldStart = bracketStart - fieldName.length;
      
      // Find the matching closing bracket
      bracketDepth = 1;
      let bracketEnd = bracketStart + 1;
      for (let i = bracketStart + 1; i < expr.length; i++) {
        if (expr[i] === '[') {
          bracketDepth++;
        } else if (expr[i] === ']') {
          bracketDepth--;
          if (bracketDepth === 0) {
            bracketEnd = i;
            break;
          }
        }
      }
      
      if (bracketDepth !== 0) {
        break; // Unmatched brackets
      }
      
      const offsetExpr = expr.substring(bracketStart + 1, bracketEnd);
      const matchStart = fieldStart;
      const matchEnd = bracketEnd + 1;
      
      try {
        // Evaluate the offset expression
        const offsetResult = this._evaluateExpression(offsetExpr);
        const offset = typeof offsetResult === 'string' ? parseFloat(offsetResult) : offsetResult;
        
        if (isNaN(offset)) {
          throw new Error(`Invalid offset expression: ${offsetExpr}`);
        }
        
        // Get the value from the offset row
        const value = this._getFieldValueWithOffset(fieldName, Math.round(offset));
        
        if (value !== null && value !== undefined) {
          const key = `__PROTECTED_${protectedIndex}__`;
          protectedValues[protectedIndex] = typeof value === 'string' ? `"${value}"` : String(value);
          protectedIndex++;
          
          // Replace the indexed field reference
          expr = expr.substring(0, matchStart) + key + expr.substring(matchEnd);
          changed = true;
        } else {
          // Field not found or out of bounds, replace with empty string
          const key = `__PROTECTED_${protectedIndex}__`;
          protectedValues[protectedIndex] = '""'; // Empty string
          protectedIndex++;
          expr = expr.substring(0, matchStart) + key + expr.substring(matchEnd);
          changed = true;
        }
      } catch (error) {
        // If offset evaluation fails, treat as regular field reference (offset 0)
        const value = this._getFieldValue(fieldName);
        if (value !== null && value !== undefined) {
          const key = `__PROTECTED_${protectedIndex}__`;
          protectedValues[protectedIndex] = typeof value === 'string' ? `"${value}"` : String(value);
          protectedIndex++;
          expr = expr.substring(0, matchStart) + key + expr.substring(matchEnd);
          changed = true;
        }
      }
    }
    
    // Now replace regular field references (without offsets)
    // Use a regex that excludes field names followed by [
    const fieldRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\[)/g;
    expr = expr.replace(fieldRegex, (match, fieldName) => {
      // Skip if this looks like it might be part of an indexed reference we already processed
      // (though at this point, indexed references should already be replaced)
      const value = this._getFieldValue(fieldName);
      if (value !== null && value !== undefined) {
        const key = `__PROTECTED_${protectedIndex}__`;
        protectedValues[protectedIndex] = typeof value === 'string' ? `"${value}"` : String(value);
        protectedIndex++;
        return key;
      }
      return match;
    });
    
    // Restore protected values
    for (let i = 0; i < protectedValues.length; i++) {
      expr = expr.replace(`__PROTECTED_${i}__`, protectedValues[i]);
    }
    
    return expr;
  }
  
  _getFieldValueWithOffset(fieldName, offset) {
    // Get field value from a row offset by 'offset' from the current row
    // offset > 0 means next rows, offset < 0 means previous rows, offset = 0 means current row
    if (!this.row || !this.currentTable) {
      return null;
    }
    
    const table = this.tables[this.currentTable];
    if (!table) {
      return null;
    }
    
    // Get current row index
    let currentIndex = table.rows.indexOf(this.row);
    if (currentIndex === -1) {
      // Try to find by comparing field values
      for (let i = 0; i < table.rows.length; i++) {
        const row = table.rows[i];
        let matches = true;
        for (const col of table.schema) {
          if (row[col.name] !== this.row[col.name]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          currentIndex = i;
          break;
        }
      }
    }
    
    if (currentIndex === -1) {
      return null; // Current row not found
    }
    
    // Calculate target row index
    const targetIndex = currentIndex + offset;
    
    // Check bounds
    if (targetIndex < 0 || targetIndex >= table.rows.length) {
      return null; // Out of bounds
    }
    
    // Get value from target row
    const targetRow = table.rows[targetIndex];
    if (targetRow && targetRow.hasOwnProperty(fieldName)) {
      return targetRow[fieldName];
    }
    
    return null;
  }
  
  _getFieldValue(fieldName) {
    if (this.row && this.row.hasOwnProperty(fieldName)) {
      return this.row[fieldName];
    }
    return null;
  }
  
  _handleStringLiterals(expr) {
    // Handle single-quoted strings
    return expr.replace(/'([^']*)'/g, (match, content) => {
      return `"${content}"`;
    });
  }
  
  _handleBooleanOps(expr) {
    // Handle ! (NOT) - match numbers, quoted strings, or function results
    // Process iteratively to handle all ! operators
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      // Match ! followed by a number (with optional decimal), quoted string, or standalone number
      // This handles both !1 and !"1" cases
      const notRegex = /!(\d+(?:\.\d+)?|"[^"]*")/g;
      const newExpr = expr.replace(notRegex, (match, val) => {
        changed = true;
        const num = this._toNumber(val);
        // If num is truthy (non-zero), return 0 (false), else return 1 (true)
        return num ? 0 : 1;
      });
      if (newExpr !== expr) {
        expr = newExpr;
      } else {
        break;
      }
    }
    
    // Handle && (AND) - need to be careful with order
    const andRegex = /(\d+(?:\.\d+)?|"[^"]*")\s*&&\s*(\d+(?:\.\d+)?|"[^"]*")/g;
    while (andRegex.test(expr)) {
      expr = expr.replace(andRegex, (match, left, right) => {
        const l = this._toNumber(left);
        const r = this._toNumber(right);
        return (l && r) ? 1 : 0;
      });
    }
    
    // Handle || (OR)
    const orRegex = /(\d+(?:\.\d+)?|"[^"]*")\s*\|\|\s*(\d+(?:\.\d+)?|"[^"]*")/g;
    while (orRegex.test(expr)) {
      expr = expr.replace(orRegex, (match, left, right) => {
        const l = this._toNumber(left);
        const r = this._toNumber(right);
        return (l || r) ? 1 : 0;
      });
    }
    
    return expr;
  }
  
  _handleComparisons(expr) {
    // Ensure expr is a string (defensive check)
    if (typeof expr !== 'string') {
      expr = String(expr);
    }
    
    // Pattern to match values: numbers (with optional decimal, including negative) or quoted strings
    // Also handles already-evaluated numeric expressions
    const valuePattern = /(-?\d+(?:\.\d+)?|"[^"]*")/;
    
    // Process comparisons in order: != first (to avoid matching = in !=), then <, >, =
    // Use a loop to handle multiple comparisons in the expression
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      
      // Handle != (must come before = to avoid matching = in !=)
      // Note: valuePattern has a capturing group, so we get nested groups
      // match[1] = left value, match[3] = right value (not match[2]!)
      const notEqualPattern = new RegExp(`(${valuePattern.source})\\s*!=\\s*(${valuePattern.source})`, 'g');
      expr = expr.replace(notEqualPattern, (match, ...args) => {
        // Due to nested capturing groups: args[0]=left, args[1]=inner left, args[2]=right
        const left = args[0];
        const right = args[2];
        changed = true;
        return String(this._compareValues(left, right, '!='));
      });
      
      // Handle <
      const lessPattern = new RegExp(`(${valuePattern.source})\\s*<\\s*(${valuePattern.source})`, 'g');
      expr = expr.replace(lessPattern, (match, ...args) => {
        const left = args[0];
        const right = args[2];
        changed = true;
        return String(this._compareValues(left, right, '<'));
      });
      
      // Handle >
      const greaterPattern = new RegExp(`(${valuePattern.source})\\s*>\\s*(${valuePattern.source})`, 'g');
      expr = expr.replace(greaterPattern, (match, ...args) => {
        const left = args[0];
        const right = args[2];
        changed = true;
        return String(this._compareValues(left, right, '>'));
      });
      
      // Handle = (must come after !=)
      const equalPattern = new RegExp(`(${valuePattern.source})\\s*=\\s*(${valuePattern.source})`, 'g');
      expr = expr.replace(equalPattern, (match, ...args) => {
        const left = args[0];
        const right = args[2];
        changed = true;
        return String(this._compareValues(left, right, '='));
      });
    }
    
    return expr;
  }
  
  _compareValues(leftStr, rightStr, operator) {
    // Determine if operands are strings or numbers
    const leftIsString = typeof leftStr === 'string' && leftStr.startsWith('"') && leftStr.endsWith('"');
    const rightIsString = typeof rightStr === 'string' && rightStr.startsWith('"') && rightStr.endsWith('"');
    
    // Check type compatibility: INT and REAL can be compared with each other, TEXT only with TEXT
    if (leftIsString !== rightIsString) {
      throw new Error(`Type mismatch: cannot compare ${leftIsString ? 'TEXT' : 'numeric'} with ${rightIsString ? 'TEXT' : 'numeric'}`);
    }
    
    // Perform comparison
    let result;
    if (leftIsString) {
      // TEXT comparison
      const leftVal = leftStr.slice(1, -1);
      const rightVal = rightStr.slice(1, -1);
      switch (operator) {
        case '<':
          result = leftVal < rightVal;
          break;
        case '>':
          result = leftVal > rightVal;
          break;
        case '=':
          result = leftVal === rightVal;
          break;
        case '!=':
          result = leftVal !== rightVal;
          break;
        default:
          throw new Error(`Unknown comparison operator: ${operator}`);
      }
    } else {
      // Numeric comparison (INT and REAL are compatible)
      const leftNum = this._toNumber(leftStr);
      const rightNum = this._toNumber(rightStr);
      switch (operator) {
        case '<':
          result = leftNum < rightNum;
          break;
        case '>':
          result = leftNum > rightNum;
          break;
        case '=':
          result = leftNum === rightNum;
          break;
        case '!=':
          result = leftNum !== rightNum;
          break;
        default:
          throw new Error(`Unknown comparison operator: ${operator}`);
      }
    }
    
    // Return 1 if true, 0 if false (as number, not string)
    return result ? 1 : 0;
  }
  
  _toComparable(val) {
    if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
      return val.slice(1, -1);
    }
    return this._toNumber(val);
  }
  
  _handleUnaryMinus(expr) {
    // Handle unary minus: -expression
    // This processes unary minus before binary arithmetic operations
    // Pattern: - at start of expression or after operators/whitespace/parens, followed by a number or parenthesized expression
    // Note: Handles cases like -Amount where Amount might be negative (results in --5 which becomes 5)
    
    let changed = true;
    let iterations = 0;
    
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      
      // Match unary minus at start or after operators/whitespace/parens
      // Look for: (start|operator|whitespace|paren) whitespace* - (number|negative number|parenthesized expression)
      // This avoids matching binary subtraction (which has a number before the -)
      // Note: number can be negative (e.g., --5 should become 5)
      const unaryMinusPattern = /(^|[\s\+\-\*\/\^\(])\s*-\s*(-?\d+(?:\.\d+)?|\([^)]+\))/;
      const match = expr.match(unaryMinusPattern);
      
      if (match) {
        const beforeMinus = match[1]; // Character before minus (or empty string at start)
        const value = match[2]; // Value to negate
        
        // Verify it's unary (not binary subtraction)
        // If beforeMinus is empty (start) or is an operator/whitespace/paren, it's unary
        const isUnary = match.index === 0 || /[\s\+\-\*\/\^\(]/.test(beforeMinus);
        
        if (isUnary) {
          let negatedValue;
          
          // If value is in parentheses, evaluate the inner expression
          if (value.startsWith('(') && value.endsWith(')')) {
            const innerExpr = value.slice(1, -1);
            const innerResult = this._evaluateExpression(innerExpr);
            const innerNum = this._toNumber(String(innerResult));
            negatedValue = -innerNum;
          } else {
            // It's a number (may be negative)
            const num = parseFloat(value);
            if (isNaN(num)) {
              throw new Error(`Cannot apply unary minus to non-numeric value: ${value}`);
            }
            negatedValue = -num;
          }
          
          // Replace the unary minus expression
          // If beforeMinus is just whitespace or empty, don't include it in replacement
          const prefix = (beforeMinus === '' || /^\s+$/.test(beforeMinus)) ? '' : beforeMinus;
          const replacement = prefix + String(negatedValue);
          const newExpr = expr.substring(0, match.index) + replacement + expr.substring(match.index + match[0].length);
          
          // Only mark as changed if the expression actually changed
          if (newExpr !== expr) {
            expr = newExpr;
            changed = true;
          } else {
            // Expression didn't change, stop processing to avoid infinite loop
            changed = false;
          }
        }
      }
    }
    
    return expr;
  }
  
  _handleArithmetic(expr) {
    // Protect quoted strings from arithmetic operations
    const protectedStrings = [];
    let protectedIndex = 0;
    
    expr = expr.replace(/"([^"]*)"/g, (match, content) => {
      const key = `__STRING_${protectedIndex}__`;
      protectedStrings[protectedIndex] = match;
      protectedIndex++;
      return key;
    });
    
    // Handle exponentiation (only on numbers, not protected strings)
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return Math.pow(parseFloat(left), parseFloat(right));
    });
    
    // Handle multiplication and division (only on numbers, not protected strings)
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) * parseFloat(right);
    });
    
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) / parseFloat(right);
    });
    
    // Handle addition and subtraction (only on numbers, not protected strings)
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) + parseFloat(right);
    });
    
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) - parseFloat(right);
    });
    
    // Restore protected strings
    for (let i = 0; i < protectedStrings.length; i++) {
      expr = expr.replace(`__STRING_${i}__`, protectedStrings[i]);
    }
    
    // Clean up string quotes and convert to number if possible
    // Only strip quotes if the entire expression is just a quoted string (no operators)
    // This prevents stripping quotes from expressions like "USD" = "USD"
    if (expr.startsWith('"') && expr.endsWith('"') && !expr.includes('=') && !expr.includes('<') && !expr.includes('>') && !expr.includes('!') && !expr.includes('+') && !expr.includes('-') && !expr.includes('*') && !expr.includes('/') && !expr.includes('^')) {
      return expr.slice(1, -1);
    }
    
    const num = parseFloat(expr);
    if (!isNaN(num) && expr.trim() === String(num)) {
      // Return as string to ensure compatibility with subsequent operations
      return String(num);
    }
    
    return expr;
  }
  
  _toNumber(val) {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      if (val.startsWith('"') && val.endsWith('"')) {
        const str = val.slice(1, -1);
        return str === '' ? 0 : 1;
      }
      const num = parseFloat(val);
      return isNaN(num) ? 0 : num;
    }
    return val ? 1 : 0;
  }
}

// API Routes
app.get('/api/tables', async (req, res) => {
  try {
    const result = await loadCSVFiles();
    if (result.success) {
      // Convert tables to serializable format
      const serialized = {};
      for (const [name, table] of Object.entries(tables)) {
        serialized[name] = {
          schema: table.schema,
          rows: table.rows,
          originalFile: table.originalFile
        };
      }
      res.json({ success: true, tables: serialized });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    await logError('Failed to get tables', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Restart endpoint - performs a complete reset equivalent to a cold start.
 * Clears main.log, deletes all tables from memory, resets command logging,
 * and reloads CSV files from disk.
 * 
 * @route POST /api/restart
 * @returns {Promise<Object>} Success message
 */
app.post('/api/restart', async (req, res) => {
  try {
    // Clear main.log file (same as cold start)
    try {
      await fs.unlink(MAIN_LOG).catch(() => {
        // File doesn't exist, that's okay
      });
      // Create empty log file
      await fs.writeFile(MAIN_LOG, '', 'utf-8');
    } catch (error) {
      console.error('Failed to clear log file on restart:', error);
    }
    
    // Clear all tables from memory
    tables = {};
    
    // Reset command logging
    commandLoggingEnabled = false;
    
    // Log the restart (after clearing the log, so this is the first entry)
    await logAction('Server restart - cold start');
    
    // Reload CSV files from disk
    const result = await loadCSVFiles(true); // Reset tables on restart
    
    res.json({ success: true, message: 'Restarted' });
  } catch (error) {
    await logError('Failed to restart', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * Central command dispatcher endpoint.
 * All table manipulation commands are routed through this endpoint.
 * 
 * Supported commands:
 * - SAVE_TABLE: Save table to CSV file
 * - DROP_COLUMNS: Remove multiple columns from the table
 * - RENAME_TABLE: Rename the table
 * - DELETE_ROWS: Delete rows matching an expression
 * - COLLAPSE_TABLE: Group and sum numeric columns
 * - REPLACE_TEXT: Replace text in a TEXT column using regex
 * - ADD_COLUMN: Add a column with values from an expression
 * - JOIN_TABLE: Join two tables on a specified column
 * - COPY_TABLE: Copy table to a new name
 * - SORT_TABLE: Sort table by column and order
 * - DELETE_TABLE: Delete a table
 * - GROUP_TABLE: Group by column and sum specified columns
 * - REORDER_COLUMNS: Reorder columns to place specified ones first
 * 
 * @route POST /api/command
 * @param {string} command - The command name
 * @param {string} tableName - The target table name
 * @param {Object} params - Command-specific parameters
 * @returns {Promise<Object>} Result object with success flag and data/error
 */
app.post('/api/command', async (req, res) => {
  let { command, params, tableName } = req.body;
  
  // Normalize table names (remove .csv/.CSV extension if present)
  // SPLICE_TABLES doesn't require tableName
  if (tableName && command !== 'SPLICE_TABLES') {
    tableName = tableName.replace(/\.(csv|CSV)$/i, '');
  }
  if (params && params.tableName1) {
    params.tableName1 = params.tableName1.replace(/\.(csv|CSV)$/i, '');
  }
  if (params && params.newName) {
    params.newName = params.newName.replace(/\.(csv|CSV)$/i, '');
  }
  // Normalize table names in selectedTables array for SPLICE_TABLES
  if (params && params.selectedTables && Array.isArray(params.selectedTables)) {
    params.selectedTables = params.selectedTables.map(name => name.replace(/\.(csv|CSV)$/i, ''));
  }
  
  try {
    await logAction(`Command: ${command} on table: ${tableName} with params: ${JSON.stringify(params)}`);
    
    // Log command to commands.txt if logging is enabled
    if (commandLoggingEnabled) {
      await fs.appendFile(COMMANDS_LOG, `${command} ${tableName || ''} ${JSON.stringify(params || {})}\n`);
    }
    
    // ========================================================================
    // CENTRAL COMMAND DISPATCH
    // All table manipulation commands are routed through this switch statement.
    // This ensures consistent logging, error handling, and parameter normalization.
    // Commands handled: SAVE_TABLE, DROP_COLUMNS, RENAME_TABLE, DELETE_ROWS,
    // COLLAPSE_TABLE, REPLACE_TEXT, ADD_COLUMN, JOIN_TABLE, COPY_TABLE,
    // SORT_TABLE, DELETE_TABLE, GROUP_TABLE, REORDER_COLUMNS, CONVERT_COLUMN,
    // SPLICE_TABLES
    // ========================================================================
    let result;
    switch (command) {
      case 'SAVE_TABLE':
        result = await saveTable(tableName);
        break;
      case 'DROP_COLUMNS':
        result = await dropColumns(tableName, params.columns);
        break;
      case 'RENAME_TABLE':
        result = await renameTable(tableName, params.newName);
        break;
      case 'DELETE_ROWS':
        result = await deleteRow(tableName, params.expression);
        break;
      case 'COLLAPSE_TABLE':
        if (!params || !params.newName) {
          result = { success: false, error: 'New table name is required' };
        } else {
          result = await collapseTable(tableName, params.columnName, params.newName);
        }
        break;
      case 'REPLACE_TEXT':
        result = await replaceText(tableName, params.columnName, params.regex, params.replacement);
        break;
      case 'ADD_COLUMN':
        if (!params || !params.columnType) {
          result = { success: false, error: 'Column type is required' };
        } else {
          result = await addColumn(tableName, params.columnName, params.expression, params.columnType);
        }
        break;
      case 'JOIN_TABLE':
        if (!params || !params.newName) {
          result = { success: false, error: 'New table name is required' };
        } else {
          result = await joinTable(tableName, params.tableName1, params.joinColumn, params.newName);
        }
        break;
      case 'COPY_TABLE':
        if (!tableName) {
          result = { success: false, error: 'Source table name is required' };
        } else if (!params || !params.newName) {
          result = { success: false, error: 'New table name is required' };
        } else {
          await logAction(`COPY_TABLE: copying from ${tableName} to ${params.newName}`);
          result = await copyTable(tableName, params.newName);
        }
        break;
      case 'SORT_TABLE':
        result = await sortTable(tableName, params.columnName, params.order);
        break;
      case 'DELETE_TABLE':
        result = await deleteTable(tableName);
        break;
      case 'GROUP_TABLE':
        if (!params || !params.newName) {
          result = { success: false, error: 'New table name is required' };
        } else {
          result = await groupTable(tableName, params.groupColumn, params.columns, params.newName);
        }
        break;
      case 'REORDER_COLUMNS':
        result = await reorderColumns(tableName, params.columns);
        break;
      case 'CONVERT_COLUMN':
        result = await convertColumn(tableName, params.columnName);
        break;
      case 'SPLICE_TABLES':
        if (!params || !params.newName) {
          result = { success: false, error: 'New table name is required' };
        } else if (!params.selectedTables || !Array.isArray(params.selectedTables) || params.selectedTables.length === 0) {
          result = { success: false, error: 'At least one table must be selected' };
        } else {
          result = await spliceTables(params.newName, params.selectedTables);
        }
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    
    if (result.success) {
      await logAction(`Command ${command} succeeded`);
    } else {
      await logError(`Command ${command} failed`, new Error(result.error));
    }
    
    res.json(result);
  } catch (error) {
    await logError(`Command ${command} error`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// Command Implementations
// ============================================================================

/**
 * Saves a table to a CSV file in the Data directory.
 * The file will be named {tableName}.CSV and will overwrite existing files.
 * 
 * @param {string} tableName - The name of the table to save
 * @returns {Promise<{success: boolean, error?: string, filePath?: string}>}
 */
async function saveTable(tableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const filePath = path.join(DATA_DIR, `${tableName}.CSV`);
  
  // Helper function to escape CSV field
  function escapeCSVField(value) {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return '';
    }
    
    const str = String(value);
    // If field contains comma, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      // Escape any existing quotes by doubling them
      const escapedQuotes = str.replace(/"/g, '""');
      // Wrap in quotes
      return '"' + escapedQuotes + '"';
    }
    return str;
  }
  
  // Build CSV content
  const schemaLine = table.schema.map(col => `${col.name}:${col.type}`).join(',');
  const lines = [schemaLine];
  
  for (const row of table.rows) {
    const values = table.schema.map(col => {
      let value = row[col.name];
      if (col.type === 'REAL') {
        if (typeof value === 'number') {
          value = value.toFixed(1);
        } else if (typeof value === 'string') {
          // Handle string values that represent REAL numbers
          const num = parseFloat(value);
          if (!isNaN(num)) {
            value = num.toFixed(1);
          }
        }
      } else if (value === null || value === undefined) {
        value = '';
      }
      const escaped = escapeCSVField(value);
      // Ensure we don't accidentally trim quotes
      return escaped;
    });
    const line = values.join(',');
    lines.push(line);
  }
  
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
  const absolutePath = path.resolve(filePath);
  await logAction(`Saved table ${tableName} to file: ${absolutePath}`);
  return { success: true };
}

/**
 * Removes multiple columns from a table.
 * 
 * @param {string} tableName - The name of the table
 * @param {Array<string>} columns - Array of column names to remove
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function dropColumns(tableName, columns) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    return { success: false, error: 'At least one column is required' };
  }
  
  const table = tables[tableName];
  const columnsToRemove = new Set(columns);
  const missingColumns = [];
  
  // Verify all columns exist
  for (const colName of columns) {
    const colExists = table.schema.some(col => col.name === colName);
    if (!colExists) {
      missingColumns.push(colName);
    }
  }
  
  if (missingColumns.length > 0) {
    return { success: false, error: `Columns not found: ${missingColumns.join(', ')}` };
  }
  
  // Remove columns from schema (in reverse order to maintain indices)
  const columnsToRemoveArray = Array.from(columnsToRemove);
  for (let i = table.schema.length - 1; i >= 0; i--) {
    if (columnsToRemove.has(table.schema[i].name)) {
      table.schema.splice(i, 1);
    }
  }
  
  // Remove columns from all rows
  for (const row of table.rows) {
    for (const colName of columnsToRemoveArray) {
      delete row[colName];
    }
  }
  
  return { success: true, table: serializeTable(table) };
}

/**
 * Renames a table.
 * 
 * @param {string} tableName - The current table name
 * @param {string} newName - The new table name
 * @returns {Promise<{success: boolean, error?: string, newTableName?: string}>}
 */
async function renameTable(tableName, newName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (tables[newName]) {
    return { success: false, error: `Table ${newName} already exists` };
  }
  
  tables[newName] = tables[tableName];
  delete tables[tableName];
  tables[newName].originalFile = `${newName}.CSV`;
  
  return { success: true, newTableName: newName };
}

/**
 * Deletes rows from a table where the expression evaluates to true (non-zero).
 * 
 * @param {string} tableName - The name of the table
 * @param {string} expression - The augmented expression to evaluate for each row
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function deleteRow(tableName, expression) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const evaluator = new ExpressionEvaluator(null, tables, tableName);
  const filteredRows = [];
  
  for (const row of table.rows) {
    evaluator.row = row;
    try {
      const result = evaluator.evaluate(expression);
      // Convert result to number for proper truthiness check
      // Keep rows where expression evaluates to false (zero)
      // Delete rows where expression evaluates to true (non-zero)
      // Convert result to number for proper truthiness check
      let numResult;
      if (typeof result === 'string') {
        // Remove quotes if present
        const cleanResult = result.replace(/^"|"$/g, '');
        numResult = parseFloat(cleanResult);
        // If it's a non-numeric string, keep the row (safe default - don't delete on unexpected result)
        if (isNaN(numResult)) {
          // Non-numeric string result - keep the row to be safe
          filteredRows.push(row);
          continue;
        }
      } else {
        numResult = result;
      }
      
      // Keep rows where result is 0 (false), delete rows where result is non-zero (true)
      // numResult === 0 means expression is false, so keep the row
      // numResult !== 0 means expression is true, so delete the row (don't add to filteredRows)
      if (numResult === 0) {
        filteredRows.push(row);
      }
      // If numResult is non-zero, the row is deleted (not added to filteredRows)
    } catch (error) {
      // If evaluation fails, keep the row (don't delete on error)
      await logError(`Error evaluating DELETE_ROWS expression for row`, error);
      filteredRows.push(row);
    }
  }
  
  table.rows = filteredRows;
  return { success: true, table: serializeTable(table) };
}

/**
 * Collapses a table by grouping on a TEXT column and summing INT/REAL columns.
 * If no columnName is provided, creates a single row with sums of all numeric columns.
 * 
 * @param {string} tableName - The name of the table
 * @param {string} columnName - Optional TEXT column to group by
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function collapseTable(tableName, columnName, newTableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!newTableName) {
    return { success: false, error: 'New table name is required' };
  }
  
  // Check if new table name already exists
  if (tables[newTableName]) {
    return { success: false, error: `Table ${newTableName} already exists` };
  }
  
  const table = tables[tableName];
  const groupCol = table.schema.find(col => col.name === columnName);
  
  if (columnName && !groupCol) {
    return { success: false, error: `Column ${columnName} not found` };
  }
  
  if (columnName && groupCol.type !== 'TEXT') {
    return { success: false, error: `Column ${columnName} must be of type TEXT` };
  }
  
  const intRealCols = table.schema.filter(col => col.type === 'INT' || col.type === 'REAL');
  const groups = {};
  
  for (const row of table.rows) {
    const key = columnName ? String(row[columnName] || '') : '__all__';
    if (!groups[key]) {
      groups[key] = {};
      if (columnName) {
        groups[key][columnName] = row[columnName];
      }
      for (const col of intRealCols) {
        groups[key][col.name] = 0;
      }
    }
    
    for (const col of intRealCols) {
      const val = row[col.name] || 0;
      groups[key][col.name] = (groups[key][col.name] || 0) + val;
    }
  }
  
  const newSchema = columnName ? [groupCol, ...intRealCols] : intRealCols;
  const newRows = Object.values(groups);
  
  tables[newTableName] = {
    schema: newSchema,
    rows: newRows,
    originalFile: `${newTableName}.CSV`
  };
  
  return { success: true, newTableName: newTableName, table: serializeTable(tables[newTableName]) };
}

/**
 * Replaces text in a TEXT column using a regular expression.
 * Supports replacement patterns like $1, $2 for matched groups.
 * 
 * @param {string} tableName - The name of the table
 * @param {string} columnName - The TEXT column to modify
 * @param {string} regex - The regular expression pattern
 * @param {string} replacement - The replacement string (supports $x for groups)
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function replaceText(tableName, columnName, regex, replacement) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const col = table.schema.find(c => c.name === columnName);
  if (!col || col.type !== 'TEXT') {
    return { success: false, error: `Column ${columnName} not found or not TEXT type` };
  }
  
  const regexObj = new RegExp(regex, 'g');
  
  for (const row of table.rows) {
    const value = String(row[columnName] || '');
    const newValue = value.replace(regexObj, (match, ...groups) => {
      let result = replacement;
      for (let i = 0; i < groups.length; i++) {
        result = result.replace(`$${i + 1}`, groups[i] || '');
      }
      result = result.replace('$0', match);
      return result;
    });
    row[columnName] = newValue;
  }
  
  return { success: true, table: serializeTable(table) };
}

/**
 * Adds a new column to a table with values computed from an expression.
 * Column type is specified by the user.
 * 
 * @param {string} tableName - The name of the table
 * @param {string} columnName - The name of the new column
 * @param {string} expression - The augmented expression to evaluate for each row
 * @param {string} columnType - The type of the column (TEXT, INT, or REAL)
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function addColumn(tableName, columnName, expression, columnType) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!columnType || !['TEXT', 'INT', 'REAL'].includes(columnType)) {
    return { success: false, error: 'Invalid column type. Must be TEXT, INT, or REAL' };
  }
  
  const table = tables[tableName];
  
  // Use the user-specified column type
  const colType = columnType;
  
  table.schema.push({ name: columnName, type: colType });
  
  // Evaluate expression for each row
  const evaluator = new ExpressionEvaluator(null, tables, tableName);
  for (const row of table.rows) {
    evaluator.row = row;
    const value = evaluator.evaluate(expression);
    row[columnName] = value;
  }
  
  return { success: true, table: serializeTable(table) };
}

// Helper function to check if expression references REAL columns
function checkExpressionForRealColumns(expression, table) {
  for (const col of table.schema) {
    if (col.type === 'REAL') {
      // Check if column name appears in expression (as a word boundary)
      const regex = new RegExp(`\\b${col.name}\\b`);
      if (regex.test(expression)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Joins the current table with another table on a specified column.
 * For each row in the current table, finds matching rows in tableName1 and appends their columns.
 * If no match is found, blank values are appended.
 * Creates a new table with the joined results.
 * 
 * @param {string} tableName - The current table name
 * @param {string} tableName1 - The table to join with
 * @param {string} joinColumn - The column name to join on (must exist in both tables)
 * @param {string} newTableName - The name for the new joined table
 * @returns {Promise<{success: boolean, error?: string, newTableName?: string, table?: Object}>}
 */
async function joinTable(tableName, tableName1, joinColumn, newTableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!tables[tableName1]) {
    return { success: false, error: `Table ${tableName1} not found` };
  }
  
  if (!newTableName) {
    return { success: false, error: 'New table name is required' };
  }
  
  // Check if new table name already exists
  if (tables[newTableName]) {
    return { success: false, error: `Table ${newTableName} already exists` };
  }
  
  const table = tables[tableName];
  const table1 = tables[tableName1];
  
  if (!table.schema.find(col => col.name === joinColumn)) {
    return { success: false, error: `Column ${joinColumn} not found in ${tableName}` };
  }
  
  if (!table1.schema.find(col => col.name === joinColumn)) {
    return { success: false, error: `Column ${joinColumn} not found in ${tableName1}` };
  }
  
  // Build lookup map for table1
  const lookup = {};
  for (const row of table1.rows) {
    const key = String(row[joinColumn] || '');
    if (!lookup[key]) {
      lookup[key] = row;
    }
  }
  
  // Create a deep copy of the table for the new joined table
  const newTable = {
    schema: JSON.parse(JSON.stringify(table.schema)),
    rows: JSON.parse(JSON.stringify(table.rows)),
    originalFile: `${newTableName}.CSV`
  };
  
  // Add columns from table1 (except joinColumn)
  const newCols = table1.schema.filter(col => col.name !== joinColumn);
  for (const col of newCols) {
    if (!newTable.schema.find(c => c.name === col.name)) {
      newTable.schema.push(JSON.parse(JSON.stringify(col)));
    }
  }
  
  // Join rows
  for (const row of newTable.rows) {
    const key = String(row[joinColumn] || '');
    const match = lookup[key];
    if (match) {
      for (const col of newCols) {
        row[col.name] = match[col.name];
      }
    } else {
      for (const col of newCols) {
        row[col.name] = col.type === 'TEXT' ? '' : (col.type === 'INT' ? 0 : 0.0);
      }
    }
  }
  
  // Store the new table
  tables[newTableName] = newTable;
  
  return { success: true, newTableName: newTableName, table: serializeTable(newTable) };
}

/**
 * Creates a copy of a table with a new name.
 * 
 * @param {string} tableName - The source table name
 * @param {string} newName - The name for the new table
 * @returns {Promise<{success: boolean, error?: string, newTableName?: string, table?: Object}>}
 */
async function copyTable(tableName, newName) {
  if (!tableName) {
    return { success: false, error: 'Source table name is required' };
  }
  if (!newName) {
    return { success: false, error: 'New table name is required' };
  }
  
  // Log available tables for debugging
  const availableTables = Object.keys(tables);
  await logAction(`COPY_TABLE: Looking for source table "${tableName}". Available tables: ${availableTables.join(', ')}`);
  
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found. Available tables: ${availableTables.join(', ')}` };
  }
  
  if (tables[newName]) {
    return { success: false, error: `Table ${newName} already exists` };
  }
  
  const table = tables[tableName];
  tables[newName] = {
    schema: JSON.parse(JSON.stringify(table.schema)),
    rows: JSON.parse(JSON.stringify(table.rows)),
    originalFile: `${newName}.CSV`
  };
  
  await logAction(`Copied table ${tableName} to ${newName}`);
  return { success: true, newTableName: newName, table: serializeTable(tables[newName]) };
}

/**
 * Sorts a table by a specified column in ascending or descending order.
 * 
 * @param {string} tableName - The name of the table
 * @param {string} columnName - The column to sort by
 * @param {string} order - Sort order: 'asc' or 'desc'
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function sortTable(tableName, columnName, order) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const col = table.schema.find(c => c.name === columnName);
  if (!col) {
    return { success: false, error: `Column ${columnName} not found` };
  }
  
  table.rows.sort((a, b) => {
    const aVal = a[columnName];
    const bVal = b[columnName];
    
    let comparison = 0;
    if (col.type === 'TEXT') {
      comparison = String(aVal).localeCompare(String(bVal));
    } else {
      comparison = (aVal || 0) - (bVal || 0);
    }
    
    return order === 'desc' ? -comparison : comparison;
  });
  
  return { success: true, table: serializeTable(table) };
}

/**
 * Deletes a table from memory.
 * 
 * @param {string} tableName - The name of the table to delete
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteTable(tableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  delete tables[tableName];
  return { success: true };
}

/**
 * Groups a table by a specified column and sums specified numeric columns for each group.
 * Creates a new table with the group column first, followed by summed columns.
 * 
 * @param {string} tableName - The name of the source table
 * @param {string} groupColumn - The column to group by
 * @param {Array<string>} columns - Array of column names (INT or REAL) to sum
 * @param {string} newTableName - The name for the new grouped table
 * @returns {Promise<{success: boolean, error?: string, newTableName?: string, table?: Object}>}
 */
async function groupTable(tableName, groupColumn, columns, newTableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!newTableName) {
    return { success: false, error: 'New table name is required' };
  }
  
  // Check if new table name already exists
  if (tables[newTableName]) {
    return { success: false, error: `Table ${newTableName} already exists` };
  }
  
  if (!groupColumn) {
    return { success: false, error: 'Group column is required' };
  }
  
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    return { success: false, error: 'At least one column to sum is required' };
  }
  
  const table = tables[tableName];
  const groupCol = table.schema.find(col => col.name === groupColumn);
  if (!groupCol) {
    return { success: false, error: `Group column ${groupColumn} not found` };
  }
  
  // Verify all sum columns exist and are numeric
  const sumCols = [];
  for (const colName of columns) {
    const col = table.schema.find(c => c.name === colName);
    if (!col) {
      return { success: false, error: `Column ${colName} not found` };
    }
    if (col.type !== 'INT' && col.type !== 'REAL') {
      return { success: false, error: `Column ${colName} must be of type INT or REAL` };
    }
    sumCols.push(col);
  }
  
  // Group rows by groupColumn value
  const groups = {};
  for (const row of table.rows) {
    const key = String(row[groupColumn] || '');
    if (!groups[key]) {
      groups[key] = {
        [groupColumn]: row[groupColumn],
        sums: {}
      };
      for (const col of sumCols) {
        groups[key].sums[col.name] = 0;
      }
    }
    
    // Sum the specified columns
    for (const col of sumCols) {
      const val = row[col.name] || 0;
      groups[key].sums[col.name] = (groups[key].sums[col.name] || 0) + val;
    }
  }
  
  // Build new schema: groupColumn first, then sum columns
  const newSchema = [groupCol, ...sumCols];
  
  // Build new rows
  const newRows = Object.values(groups).map(group => {
    const row = { [groupColumn]: group[groupColumn] };
    for (const col of sumCols) {
      row[col.name] = group.sums[col.name];
    }
    return row;
  });
  
  // Create new table instead of modifying the existing one
  tables[newTableName] = {
    schema: newSchema,
    rows: newRows,
    originalFile: `${newTableName}.CSV`
  };
  
  return { success: true, newTableName: newTableName, table: serializeTable(tables[newTableName]) };
}

/**
 * Reorders columns in a table, placing specified columns first.
 * Remaining columns follow in their original order.
 * 
 * @param {string} tableName - The name of the table
 * @param {Array<string>} columns - Array of column names to place first
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function reorderColumns(tableName, columns) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    return { success: false, error: 'At least one column is required' };
  }
  
  const table = tables[tableName];
  
  // Verify all columns exist
  const reorderCols = [];
  for (const colName of columns) {
    const col = table.schema.find(c => c.name === colName);
    if (!col) {
      return { success: false, error: `Column ${colName} not found` };
    }
    reorderCols.push(col);
  }
  
  // Build new schema: reordered columns first, then remaining columns in original order
  const reorderColNames = new Set(columns);
  const remainingCols = table.schema.filter(col => !reorderColNames.has(col.name));
  const newSchema = [...reorderCols, ...remainingCols];
  
  // Update the table schema
  table.schema = newSchema;
  
  return { success: true, table: serializeTable(table) };
}

/**
 * Converts a TEXT column to REAL type, stripping $ signs and commas before conversion.
 * Non-numeric fields are left unchanged.
 * 
 * @param {string} tableName - The name of the table
 * @param {string} columnName - The TEXT column to convert
 * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
 */
async function convertColumn(tableName, columnName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const col = table.schema.find(c => c.name === columnName);
  if (!col) {
    return { success: false, error: `Column ${columnName} not found` };
  }
  
  if (col.type !== 'TEXT') {
    return { success: false, error: `Column ${columnName} is not of type TEXT` };
  }
  
  // Convert values: strip $ and commas, try to parse as number
  for (const row of table.rows) {
    const value = String(row[columnName] || '');
    // Strip $ signs and commas
    const cleaned = value.replace(/[$,\s]/g, '');
    
    // Try to parse as number
    if (cleaned !== '' && !isNaN(cleaned)) {
      const numValue = parseFloat(cleaned);
      if (!isNaN(numValue)) {
        row[columnName] = numValue;
      }
      // If parsing fails, leave value unchanged (it's already a string)
    }
    // If cleaned is empty or not numeric, leave value unchanged
  }
  
  // Update column type to REAL
  col.type = 'REAL';
  
  await logAction(`Converted column ${columnName} from TEXT to REAL in table ${tableName}`);
  return { success: true, table: serializeTable(table) };
}

/**
 * Creates a new table by splicing (concatenating) rows from multiple selected tables.
 * All selected tables must have matching schemas (same columns with same types).
 * 
 * @param {string} newTableName - The name for the new table
 * @param {Array<string>} selectedTables - Array of table names to splice
 * @returns {Promise<{success: boolean, error?: string, newTableName?: string, table?: Object}>}
 */
async function spliceTables(newTableName, selectedTables) {
  if (!newTableName) {
    return { success: false, error: 'New table name is required' };
  }
  
  if (!selectedTables || !Array.isArray(selectedTables) || selectedTables.length === 0) {
    return { success: false, error: 'At least one table must be selected' };
  }
  
  // Check if new table name already exists
  if (tables[newTableName]) {
    return { success: false, error: `Table ${newTableName} already exists` };
  }
  
  // Verify all selected tables exist
  for (const tableName of selectedTables) {
    if (!tables[tableName]) {
      return { success: false, error: `Table ${tableName} not found` };
    }
  }
  
  // Get schemas from all selected tables
  const tableSchemas = selectedTables.map(tableName => ({
    name: tableName,
    schema: tables[tableName].schema
  }));
  
  // Check that all schemas match
  if (tableSchemas.length > 1) {
    const firstSchema = tableSchemas[0].schema;
    
    // Helper function to compare schemas
    const schemasMatch = (schema1, schema2) => {
      if (schema1.length !== schema2.length) {
        return false;
      }
      for (let i = 0; i < schema1.length; i++) {
        if (schema1[i].name !== schema2[i].name || schema1[i].type !== schema2[i].type) {
          return false;
        }
      }
      return true;
    };
    
    // Compare all schemas against the first one
    for (let i = 1; i < tableSchemas.length; i++) {
      if (!schemasMatch(firstSchema, tableSchemas[i].schema)) {
        const firstTableName = tableSchemas[0].name;
        const mismatchedTableName = tableSchemas[i].name;
        return { 
          success: false, 
          error: `Schema mismatch: Table "${firstTableName}" and "${mismatchedTableName}" have different schemas. All tables must have matching schemas to splice.` 
        };
      }
    }
  }
  
  // All schemas match, use the first table's schema
  const mergedSchema = JSON.parse(JSON.stringify(tableSchemas[0].schema));
  
  // Collect all rows from selected tables
  const mergedRows = [];
  for (const tableName of selectedTables) {
    const table = tables[tableName];
    for (const row of table.rows) {
      // Create a deep copy of the row
      mergedRows.push(JSON.parse(JSON.stringify(row)));
    }
  }
  
  // Create new table
  tables[newTableName] = {
    schema: mergedSchema,
    rows: mergedRows,
    originalFile: `${newTableName}.CSV`
  };
  
  await logAction(`Spliced ${selectedTables.length} tables into ${newTableName} with ${mergedRows.length} rows`);
  return { success: true, newTableName: newTableName, table: serializeTable(tables[newTableName]) };
}

/**
 * Serializes a table object for transmission to the client.
 * 
 * @param {Object} table - The table object with schema and rows
 * @returns {Object} Serialized table data
 */
function serializeTable(table) {
  return {
    schema: table.schema,
    rows: table.rows
  };
}

// Rules engine
/**
 * Loads rules from a .RUL file.
 * Rules format: "OPERATION columnName expression"
 * Operations: INIT, FIXUP, CHECK
 * 
 * @param {string} fileName - The base filename (without extension) of the rules file
 * @returns {Promise<Array<{operation: string, columnName: string, expression: string}>>}
 */
async function loadRules(fileName) {
  // Try both .RUL and .rul extensions (case-insensitive)
  const rulesPathUpper = path.join(DATA_DIR, `${fileName}.RUL`);
  const rulesPathLower = path.join(DATA_DIR, `${fileName}.rul`);
  
  let content = null;
  let rulesPath = null;
  
  try {
    try {
      content = await fs.readFile(rulesPathUpper, 'utf-8');
      rulesPath = rulesPathUpper;
    } catch {
      try {
        content = await fs.readFile(rulesPathLower, 'utf-8');
        rulesPath = rulesPathLower;
      } catch {
        // File doesn't exist, return empty rules
        return [];
      }
    }
    
    await logAction(`Loading rules from ${rulesPath}`);
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    const rules = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Split by whitespace, but keep the expression together
      const firstSpace = trimmed.indexOf(' ');
      if (firstSpace === -1) continue;
      
      const operation = trimmed.substring(0, firstSpace);
      const rest = trimmed.substring(firstSpace + 1).trim();
      
      const secondSpace = rest.indexOf(' ');
      if (secondSpace === -1) continue;
      
      const columnName = rest.substring(0, secondSpace);
      const expression = rest.substring(secondSpace + 1).trim();
      
      if (operation && columnName && expression) {
        rules.push({
          operation,
          columnName,
          expression
        });
        await logAction(`Parsed rule: ${operation} ${columnName} ${expression}`);
      }
    }
    
    await logAction(`Loaded ${rules.length} rules from ${rulesPath}`);
    return rules;
  } catch (error) {
    await logError(`Failed to load rules from ${rulesPath || fileName}`, error);
    return [];
  }
}

app.post('/api/rules/run', async (req, res) => {
  const { fileName, row, operation } = req.body;
  
  try {
    const rules = await loadRules(fileName);
    const filteredRules = rules.filter(r => r.operation === operation);
    const errors = [];
    
    const table = Object.values(tables).find(t => t.originalFile === `${fileName}.CSV`);
    if (!table) {
      return res.json({ success: false, error: 'Table not found' });
    }
    
    const evaluator = new ExpressionEvaluator(row, tables, fileName);
    
    for (const rule of filteredRules) {
      try {
        if (rule.operation === 'INIT' || rule.operation === 'FIXUP') {
          const value = evaluator.evaluate(rule.expression);
          row[rule.columnName] = value;
        } else if (rule.operation === 'CHECK') {
          const result = evaluator.evaluate(rule.expression);
          if (!result || result === 0) {
            errors.push(rule.columnName);
          }
        }
      } catch (error) {
        errors.push(rule.columnName);
      }
    }
    
    res.json({ success: errors.length === 0, errors });
  } catch (error) {
    await logError('Rules execution error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Command logging controls
app.post('/api/logging/enable', async (req, res) => {
  commandLoggingEnabled = true;
  await logAction('Command logging enabled');
  res.json({ success: true });
});

app.post('/api/logging/disable', async (req, res) => {
  commandLoggingEnabled = false;
  await logAction('Command logging disabled');
  res.json({ success: true });
});

app.get('/api/logging/status', (req, res) => {
  res.json({ enabled: commandLoggingEnabled });
});

app.post('/api/commands/save', async (req, res) => {
  // Commands are already saved as they're executed
  res.json({ success: true });
});

app.post('/api/commands/clear', async (req, res) => {
  try {
    await fs.writeFile(COMMANDS_LOG, '', 'utf-8');
    await logAction('Commands log cleared');
    res.json({ success: true });
  } catch (error) {
    await logError('Failed to clear commands log', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/commands/replay', async (req, res) => {
  try {
    const content = await fs.readFile(COMMANDS_LOG, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    const commands = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Format is: command tableName JSON_PARAMS
      // Find the first two spaces to separate command, tableName, and JSON
      const firstSpace = trimmed.indexOf(' ');
      if (firstSpace === -1) continue;
      
      const command = trimmed.substring(0, firstSpace);
      const rest = trimmed.substring(firstSpace + 1).trim();
      
      // Find the start of JSON (should start with {)
      const jsonStart = rest.indexOf('{');
      let tableName = '';
      let params = {};
      
      if (jsonStart === -1) {
        // No JSON found, rest is tableName (or empty)
        tableName = rest;
      } else {
        // Extract tableName (everything before JSON)
        tableName = rest.substring(0, jsonStart).trim();
        
        // Extract and parse JSON
        try {
          // Find the matching closing brace
          let braceCount = 0;
          let jsonEnd = -1;
          for (let i = jsonStart; i < rest.length; i++) {
            if (rest[i] === '{') braceCount++;
            else if (rest[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                jsonEnd = i + 1;
                break;
              }
            }
          }
          
          if (jsonEnd > jsonStart) {
            const jsonStr = rest.substring(jsonStart, jsonEnd);
            params = JSON.parse(jsonStr);
          }
        } catch (error) {
          // If JSON parsing fails, params remains {}
          await logError('Failed to parse command params JSON', error);
        }
      }
      
      // Normalize table names (remove .csv/.CSV extension if present)
      const normalizedTableName = tableName ? tableName.replace(/\.(csv|CSV)$/i, '') : '';
      if (params && params.tableName1) {
        params.tableName1 = params.tableName1.replace(/\.(csv|CSV)$/i, '');
      }
      if (params && params.newName) {
        params.newName = params.newName.replace(/\.(csv|CSV)$/i, '');
      }
      
      commands.push({ command, tableName: normalizedTableName, params });
    }
    
    res.json({ success: true, commands });
  } catch (error) {
    // If file doesn't exist or can't be read, return empty commands
    res.json({ success: true, commands: [] });
  }
});

// Row operations
// Get initialized row data (for Add Row dialog)
app.get('/api/row/init/:tableName', async (req, res) => {
  const { tableName } = req.params;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    // Get filename without extension (case-insensitive)
    const fileName = path.basename(table.originalFile, path.extname(table.originalFile));
    await logAction(`Initializing row for table ${tableName}, originalFile: ${table.originalFile}, fileName: ${fileName}`);
    
    // Initialize row with default values
    const row = {};
    for (const col of table.schema) {
      switch (col.type) {
        case 'INT':
          row[col.name] = 0;
          break;
        case 'REAL':
          row[col.name] = 0.0;
          break;
        default:
          row[col.name] = '';
      }
    }
    
    // Run INIT rules
    const rules = await loadRules(fileName);
    await logAction(`Loading rules for ${fileName}, found ${rules.length} rules`);
    const initRules = rules.filter(r => r.operation === 'INIT');
    await logAction(`Found ${initRules.length} INIT rules`);
    const evaluator = new ExpressionEvaluator(row, tables, tableName);
    
    for (const rule of initRules) {
      try {
        await logAction(`Executing INIT rule: ${rule.columnName} = ${rule.expression}`);
        const value = evaluator.evaluate(rule.expression);
        await logAction(`INIT rule result: ${rule.columnName} = ${value}`);
        row[rule.columnName] = value;
      } catch (error) {
        await logError(`Failed to execute INIT rule for ${rule.columnName}`, error);
        // Continue with other rules
      }
    }
    
    res.json({ success: true, row });
  } catch (error) {
    await logError('Failed to initialize row', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/row/add', async (req, res) => {
  const { tableName, row } = req.body;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    // Get filename without extension (case-insensitive)
    const fileName = path.basename(table.originalFile, path.extname(table.originalFile));
    await logAction(`Adding row to table ${tableName}, originalFile: ${table.originalFile}, fileName: ${fileName}`);
    
    // Initialize row with default values if not provided
    for (const col of table.schema) {
      if (row[col.name] === undefined || row[col.name] === null) {
        switch (col.type) {
          case 'INT':
            row[col.name] = 0;
            break;
          case 'REAL':
            row[col.name] = 0.0;
            break;
          default:
            row[col.name] = '';
        }
      }
    }
    
    // Validate types
    const rules = await loadRules(fileName);
    await logAction(`Loaded ${rules.length} rules for table ${tableName} when adding row, fileName: ${fileName}`);
    await logAction(`Rules found: ${rules.map(r => `${r.operation} ${r.columnName}`).join(', ')}`);
    const evaluator = new ExpressionEvaluator(row, tables, tableName);
    const errors = [];
    for (const col of table.schema) {
      const value = row[col.name];
      if (col.type === 'INT') {
        const intVal = parseInt(value, 10);
        if (isNaN(intVal) || !Number.isInteger(parseFloat(value))) {
          errors.push(col.name);
        } else {
          row[col.name] = intVal;
        }
      } else if (col.type === 'REAL') {
        const realVal = parseFloat(value);
        if (isNaN(realVal)) {
          errors.push(col.name);
        } else {
          row[col.name] = realVal;
        }
      } else {
        row[col.name] = String(value || '');
      }
    }
    
    if (errors.length > 0) {
      return res.json({ success: false, errors });
    }
    
    // Run FIXUP rules
    const fixupRules = rules.filter(r => r.operation === 'FIXUP');
    for (const rule of fixupRules) {
      try {
        evaluator.row = row;
        const value = evaluator.evaluate(rule.expression);
        row[rule.columnName] = value;
      } catch (error) {
        errors.push(rule.columnName);
      }
    }
    
    // Run CHECK rules
    const checkRules = rules.filter(r => r.operation === 'CHECK');
    await logAction(`Running ${checkRules.length} CHECK rules for table ${tableName}`);
    for (const rule of checkRules) {
      try {
        evaluator.row = row;
        await logAction(`Executing CHECK rule: ${rule.columnName} - expression: ${rule.expression}, current value: ${row[rule.columnName]}`);
        const result = evaluator.evaluate(rule.expression);
        await logAction(`CHECK rule result for ${rule.columnName}: ${result} (type: ${typeof result}, truthy: ${!!result})`);
        if (!result || result === 0) {
          await logAction(`CHECK rule FAILED for ${rule.columnName}: expression returned ${result}`);
          errors.push(rule.columnName);
        } else {
          await logAction(`CHECK rule PASSED for ${rule.columnName}`);
        }
      } catch (error) {
        await logError(`CHECK rule error for ${rule.columnName}`, error);
        errors.push(rule.columnName);
      }
    }
    
    if (errors.length > 0) {
      await logAction(`Row add failed with ${errors.length} errors: ${errors.join(', ')}`);
      return res.json({ success: false, errors });
    }
    
    table.rows.push(row);
    await logAction(`Added row to table ${tableName}`);
    
    res.json({ success: true, table: serializeTable(table) });
  } catch (error) {
    await logError('Failed to add row', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/row/update', async (req, res) => {
  const { tableName, rowIndex, row } = req.body;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    if (rowIndex < 0 || rowIndex >= table.rows.length) {
      return res.json({ success: false, error: 'Invalid row index' });
    }
    
    const fileName = path.basename(table.originalFile, '.CSV');
    const rules = await loadRules(fileName);
    const evaluator = new ExpressionEvaluator(row, tables, tableName);
    const errors = [];
    
    // Validate and convert types
    for (const col of table.schema) {
      const value = row[col.name];
      if (col.type === 'INT') {
        const intVal = parseInt(value, 10);
        if (isNaN(intVal) || !Number.isInteger(parseFloat(value))) {
          errors.push(col.name);
        } else {
          row[col.name] = intVal;
        }
      } else if (col.type === 'REAL') {
        const realVal = parseFloat(value);
        if (isNaN(realVal)) {
          errors.push(col.name);
        } else {
          row[col.name] = realVal;
        }
      } else {
        row[col.name] = String(value || '');
      }
    }
    
    if (errors.length > 0) {
      return res.json({ success: false, errors });
    }
    
    // Run FIXUP rules
    const fixupRules = rules.filter(r => r.operation === 'FIXUP');
    for (const rule of fixupRules) {
      try {
        evaluator.row = row;
        const value = evaluator.evaluate(rule.expression);
        row[rule.columnName] = value;
      } catch (error) {
        errors.push(rule.columnName);
      }
    }
    
    // Run CHECK rules
    const checkRules = rules.filter(r => r.operation === 'CHECK');
    for (const rule of checkRules) {
      try {
        evaluator.row = row;
        const result = evaluator.evaluate(rule.expression);
        if (!result || result === 0) {
          errors.push(rule.columnName);
        }
      } catch (error) {
        errors.push(rule.columnName);
      }
    }
    
    if (errors.length > 0) {
      return res.json({ success: false, errors });
    }
    
    table.rows[rowIndex] = row;
    await logAction(`Updated row ${rowIndex} in table ${tableName}`);
    
    res.json({ success: true, table: serializeTable(table) });
  } catch (error) {
    await logError('Failed to update row', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/row/delete', async (req, res) => {
  const { tableName, rowIndex } = req.body;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    if (rowIndex < 0 || rowIndex >= table.rows.length) {
      return res.json({ success: false, error: 'Invalid row index' });
    }
    
    table.rows.splice(rowIndex, 1);
    await logAction(`Deleted row ${rowIndex} from table ${tableName}`);
    
    res.json({ success: true, table: serializeTable(table) });
  } catch (error) {
    await logError('Failed to delete row', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Gets the list of tags from commands.tag file.
 * Tags are stored one per line in plain text.
 * 
 * @route GET /api/tags
 * @returns {Promise<Object>} Result object with success flag and tags array
 */
app.get('/api/tags', async (req, res) => {
  try {
    const tagsFile = path.join(DATA_DIR, 'commands.tag');
    
    try {
      const content = await fs.readFile(tagsFile, 'utf-8');
      const tags = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      await logAction(`Loaded ${tags.length} tags from commands.tag`);
      res.json({ success: true, tags });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty tags array
        await logAction('commands.tag file not found, returning empty tags');
        res.json({ success: true, tags: [] });
      } else {
        throw error;
      }
    }
  } catch (error) {
    await logError('Failed to read tags', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Updates a row's tag field. Adds the "tag" column if it doesn't exist.
 * 
 * @route POST /api/row/tag
 * @param {string} tableName - The name of the table
 * @param {number} rowIndex - The index of the row to tag
 * @param {string} tag - The tag value to set
 * @returns {Promise<Object>} Result object with success flag and updated table
 */
app.post('/api/row/tag', async (req, res) => {
  const { tableName, rowIndex, tag } = req.body;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    if (rowIndex < 0 || rowIndex >= table.rows.length) {
      return res.json({ success: false, error: 'Invalid row index' });
    }
    
    // Check if "tag" column exists, add it if not
    let tagColumn = table.schema.find(col => col.name === 'tag');
    if (!tagColumn) {
      table.schema.push({ name: 'tag', type: 'TEXT' });
      // Initialize tag field for all existing rows
      for (const row of table.rows) {
        row.tag = '';
      }
      await logAction(`Added "tag" column to table ${tableName}`);
    }
    
    // Update the row's tag field
    table.rows[rowIndex].tag = tag || '';
    await logAction(`Tagged row ${rowIndex} in table ${tableName} with "${tag}"`);
    
    res.json({ success: true, table: serializeTable(table) });
  } catch (error) {
    await logError('Failed to tag row', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Starts the Express server and initializes the application.
 * Deletes and recreates main.log on startup.
 * 
 * @returns {Promise<void>}
 */
async function startServer() {
  await ensureDataDir();
  
  // Delete and recreate main.log file on startup
  try {
    await fs.unlink(MAIN_LOG).catch(() => {
      // File doesn't exist, that's okay
    });
    // Create empty log file
    await fs.writeFile(MAIN_LOG, '', 'utf-8');
  } catch (error) {
    console.error('Failed to initialize log file:', error);
  }
  
  await logAction('Server starting');
  
  app.listen(PORT, () => {
    console.log(`CSV Editor server running on http://localhost:${PORT}`);
  });
}

startServer();

