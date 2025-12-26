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

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    await logError('Failed to create data directory', error);
  }
}

// Logging functions
async function logAction(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  try {
    await fs.appendFile(MAIN_LOG, logEntry);
  } catch (error) {
    console.error('Failed to write to log:', error);
  }
}

async function logError(message, error) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ERROR: ${message} - ${error?.message || error}\n`;
  try {
    await fs.appendFile(MAIN_LOG, logEntry);
  } catch (err) {
    console.error('Failed to write to log:', err);
  }
}

// Initialize
let tables = {};
let commandLoggingEnabled = false;

// CSV parsing functions
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

function cleanRealValue(value) {
  if (typeof value === 'string') {
    return value.replace(/[,$]/g, '');
  }
  return value;
}

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

// Expression evaluator
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
      return condResult && condResult !== 0 ? this._evaluateExpression(trueExpr) : this._evaluateExpression(falseExpr);
    }
    
    // Handle function calls FIRST (before parentheses processing)
    expr = this._handleFunctions(expr);
    
    // Handle parentheses (but skip if they were part of function calls)
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
    
    // Handle field references
    expr = this._handleFieldReferences(expr);
    
    // Handle string literals
    expr = this._handleStringLiterals(expr);
    
    // Handle boolean operations
    expr = this._handleBooleanOps(expr);
    
    // Handle comparisons
    expr = this._handleComparisons(expr);
    
    // Handle arithmetic
    return this._handleArithmetic(expr);
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
    
    // Protect numbers
    expr = expr.replace(/\b\d+(?:\.\d+)?\b/g, (match) => {
      const key = `__PROTECTED_${protectedIndex}__`;
      protectedValues[protectedIndex] = match;
      protectedIndex++;
      return key;
    });
    
    // Now replace field references
    const fieldRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    expr = expr.replace(fieldRegex, (match, fieldName) => {
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
    const ops = [
      { pattern: /(\d+(?:\.\d+)?|"[^"]*")\s*<\s*(\d+(?:\.\d+)?|"[^"]*")/g, op: (a, b) => a < b },
      { pattern: /(\d+(?:\.\d+)?|"[^"]*")\s*>\s*(\d+(?:\.\d+)?|"[^"]*")/g, op: (a, b) => a > b },
      { pattern: /(\d+(?:\.\d+)?|"[^"]*")\s*=\s*(\d+(?:\.\d+)?|"[^"]*")/g, op: (a, b) => a == b }
    ];
    
    for (const { pattern, op } of ops) {
      expr = expr.replace(pattern, (match, left, right) => {
        const l = this._toComparable(left);
        const r = this._toComparable(right);
        return op(l, r) ? 1 : 0;
      });
    }
    
    return expr;
  }
  
  _toComparable(val) {
    if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
      return val.slice(1, -1);
    }
    return this._toNumber(val);
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
    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.slice(1, -1);
    }
    
    const num = parseFloat(expr);
    if (!isNaN(num) && expr.trim() === String(num)) {
      return num;
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

app.post('/api/restart', async (req, res) => {
  await logAction('Restart requested');
  tables = {};
  commandLoggingEnabled = false;
  const result = await loadCSVFiles(true); // Reset tables on restart
  res.json({ success: true, message: 'Restarted' });
});

app.post('/api/command', async (req, res) => {
  let { command, params, tableName } = req.body;
  
  // Normalize table names (remove .csv/.CSV extension if present)
  if (tableName) {
    tableName = tableName.replace(/\.(csv|CSV)$/i, '');
  }
  if (params && params.tableName1) {
    params.tableName1 = params.tableName1.replace(/\.(csv|CSV)$/i, '');
  }
  if (params && params.newName) {
    params.newName = params.newName.replace(/\.(csv|CSV)$/i, '');
  }
  
  try {
    await logAction(`Command: ${command} on table: ${tableName} with params: ${JSON.stringify(params)}`);
    
    if (commandLoggingEnabled) {
      await fs.appendFile(COMMANDS_LOG, `${command} ${tableName || ''} ${JSON.stringify(params || {})}\n`);
    }
    
    let result;
    switch (command) {
      case 'SAVE_TABLE':
        result = await saveTable(tableName);
        break;
      case 'DROP_COLUMN':
        result = await dropColumn(tableName, params.columnName);
        break;
      case 'RENAME_TABLE':
        result = await renameTable(tableName, params.newName);
        break;
      case 'DELETE_ROW':
        result = await deleteRow(tableName, params.expression);
        break;
      case 'COLLAPSE_TABLE':
        result = await collapseTable(tableName, params.columnName);
        break;
      case 'REPLACE_TEXT':
        result = await replaceText(tableName, params.columnName, params.regex, params.replacement);
        break;
      case 'ADD_COLUMN':
        result = await addColumn(tableName, params.columnName, params.expression);
        break;
      case 'JOIN_TABLE':
        result = await joinTable(tableName, params.tableName1, params.joinColumn);
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

// Command implementations
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
      if (col.type === 'REAL' && typeof value === 'number') {
        value = value.toFixed(2);
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

async function dropColumn(tableName, columnName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const colIndex = table.schema.findIndex(col => col.name === columnName);
  if (colIndex === -1) {
    return { success: false, error: `Column ${columnName} not found` };
  }
  
  table.schema.splice(colIndex, 1);
  for (const row of table.rows) {
    delete row[columnName];
  }
  
  return { success: true, table: serializeTable(table) };
}

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
  
  return { success: true };
}

async function deleteRow(tableName, expression) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  const evaluator = new ExpressionEvaluator(null, tables, tableName);
  const filteredRows = [];
  
  for (const row of table.rows) {
    evaluator.row = row;
    const result = evaluator.evaluate(expression);
    // Keep rows where expression evaluates to false (zero)
    // Delete rows where expression evaluates to true (non-zero)
    if (!result || result === 0) {
      filteredRows.push(row);
    }
  }
  
  table.rows = filteredRows;
  return { success: true, table: serializeTable(table) };
}

async function collapseTable(tableName, columnName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
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
  const newTableName = `${tableName}_collapsed`;
  
  tables[newTableName] = {
    schema: newSchema,
    rows: newRows,
    originalFile: `${newTableName}.CSV`
  };
  
  return { success: true, tableName: newTableName, table: serializeTable(tables[newTableName]) };
}

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

async function addColumn(tableName, columnName, expression) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  const table = tables[tableName];
  
  // Determine type from expression evaluation
  // Check multiple rows to see if result is always integer or could be real
  const evaluator = new ExpressionEvaluator(null, tables, tableName);
  let colType = 'TEXT';
  let hasNonInteger = false;
  let hasNumber = false;
  
  // Check up to 10 sample rows to determine type
  const sampleSize = Math.min(10, table.rows.length);
  for (let i = 0; i < sampleSize; i++) {
    evaluator.row = table.rows[i];
    try {
      const sampleResult = evaluator.evaluate(expression);
      if (typeof sampleResult === 'number') {
        hasNumber = true;
        if (!Number.isInteger(sampleResult)) {
          hasNonInteger = true;
          break; // Found a non-integer, definitely REAL
        }
      }
    } catch (error) {
      // Skip rows that cause errors, they'll be handled during full evaluation
    }
  }
  
  // Also check if expression involves REAL columns by checking if it contains division or references REAL columns
  if (hasNumber && !hasNonInteger) {
    // Check if expression might produce REAL values (contains division, or references REAL columns)
    const hasDivision = expression.includes('/');
    const hasRealColumns = checkExpressionForRealColumns(expression, table);
    
    if (hasDivision || hasRealColumns) {
      hasNonInteger = true; // Treat as REAL if division or REAL columns are involved
    }
  }
  
  if (hasNumber) {
    colType = hasNonInteger ? 'REAL' : 'INT';
  }
  
  table.schema.push({ name: columnName, type: colType });
  
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

async function joinTable(tableName, tableName1, joinColumn) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  if (!tables[tableName1]) {
    return { success: false, error: `Table ${tableName1} not found` };
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
  
  // Add columns from table1 (except joinColumn)
  const newCols = table1.schema.filter(col => col.name !== joinColumn);
  for (const col of newCols) {
    if (!table.schema.find(c => c.name === col.name)) {
      table.schema.push(col);
    }
  }
  
  // Join rows
  for (const row of table.rows) {
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
  
  return { success: true, table: serializeTable(table) };
}

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

async function deleteTable(tableName) {
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
  }
  
  delete tables[tableName];
  return { success: true };
}

function serializeTable(table) {
  return {
    schema: table.schema,
    rows: table.rows
  };
}

// Rules engine
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

// Start server
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

