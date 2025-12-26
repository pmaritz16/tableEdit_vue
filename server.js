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
function parseSchema(firstLine) {
  const columns = firstLine.split(',').map(col => col.trim());
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

async function loadCSVFiles() {
  await logAction('Loading CSV files from data directory');
  tables = {};
  
  try {
    const files = await fs.readdir(DATA_DIR);
    const csvFiles = files.filter(f => f.toUpperCase().endsWith('.CSV'));
    
    for (const file of csvFiles) {
      const filePath = path.join(DATA_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
      
      if (lines.length === 0) continue;
      
      const schema = parseSchema(lines[0]);
      const tableName = path.basename(file, '.CSV');
      const rows = [];
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].split(',');
        const row = {};
        
        for (let j = 0; j < schema.length; j++) {
          const col = schema[j];
          let value = j < line.length ? line[j].trim() : '';
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
    
    // Handle parentheses
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
    
    // Handle function calls
    expr = this._handleFunctions(expr);
    
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
        if (typeof field === 'string' && !field.startsWith('"')) {
          val = this._getFieldValue(field);
        } else {
          val = typeof field === 'string' && field.startsWith('"') ? field.slice(1, -1) : field;
        }
        return (val === '' || val === null || val === undefined || val === 0) ? 1 : 0;
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
      }
    };
    
    // Process functions from innermost to outermost
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
      changed = false;
      iterations++;
      
      for (const [funcName, func] of Object.entries(functions)) {
        // Match function calls with proper nesting
        const regex = new RegExp(`${funcName}\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'gi');
        const newExpr = expr.replace(regex, (match, args) => {
          changed = true;
          const argList = this._parseFunctionArgs(args);
          const result = func(...argList);
          return typeof result === 'string' ? `"${result}"` : String(result);
        });
        if (newExpr !== expr) {
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
      // Try to evaluate as expression, or return as string
      try {
        const evaluated = this._evaluateExpression(arg);
        return evaluated;
      } catch {
        // If evaluation fails, try to return the field value if it's a field name
        const fieldValue = this._getFieldValue(arg);
        if (fieldValue !== null) {
          return fieldValue;
        }
        return arg;
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
    // Handle ! (NOT)
    expr = expr.replace(/!(\d+(?:\.\d+)?|"[^"]*")/g, (match, val) => {
      const num = this._toNumber(val);
      return num ? 0 : 1;
    });
    
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
    // Handle exponentiation
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return Math.pow(parseFloat(left), parseFloat(right));
    });
    
    // Handle multiplication and division
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) * parseFloat(right);
    });
    
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) / parseFloat(right);
    });
    
    // Handle addition and subtraction
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) + parseFloat(right);
    });
    
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g, (match, left, right) => {
      return parseFloat(left) - parseFloat(right);
    });
    
    // Clean up string quotes and convert to number if possible
    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.slice(1, -1);
    }
    
    const num = parseFloat(expr);
    if (!isNaN(num)) {
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
  const result = await loadCSVFiles();
  res.json({ success: true, message: 'Restarted' });
});

app.post('/api/command', async (req, res) => {
  const { command, params, tableName } = req.body;
  
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
        result = await copyTable(tableName, params.newName);
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
  
  // Build CSV content
  const schemaLine = table.schema.map(col => `${col.name}:${col.type}`).join(',');
  const lines = [schemaLine];
  
  for (const row of table.rows) {
    const values = table.schema.map(col => {
      let value = row[col.name];
      if (col.type === 'REAL' && typeof value === 'number') {
        value = value.toFixed(2);
      }
      return String(value);
    });
    lines.push(values.join(','));
  }
  
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
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
  const evaluator = new ExpressionEvaluator(table.rows[0] || {}, tables, tableName);
  let sampleResult;
  try {
    sampleResult = evaluator.evaluate(expression);
  } catch (error) {
    return { success: false, error: `Expression error: ${error.message}` };
  }
  
  let colType = 'TEXT';
  if (typeof sampleResult === 'number') {
    colType = Number.isInteger(sampleResult) ? 'INT' : 'REAL';
  }
  
  table.schema.push({ name: columnName, type: colType });
  
  for (const row of table.rows) {
    evaluator.row = row;
    const value = evaluator.evaluate(expression);
    row[columnName] = value;
  }
  
  return { success: true, table: serializeTable(table) };
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
  if (!tables[tableName]) {
    return { success: false, error: `Table ${tableName} not found` };
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
  
  return { success: true };
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
  const rulesPath = path.join(DATA_DIR, `${fileName}.RUL`);
  try {
    const content = await fs.readFile(rulesPath, 'utf-8');
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
      }
    }
    
    return rules;
  } catch (error) {
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
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 1) {
        const command = parts[0];
        const tableName = parts[1] || '';
        let params = {};
        try {
          if (parts.length > 2) {
            params = JSON.parse(parts.slice(2).join(' '));
          }
        } catch {
          // Ignore parse errors
        }
        commands.push({ command, tableName, params });
      }
    }
    
    res.json({ success: true, commands });
  } catch (error) {
    res.json({ success: true, commands: [] });
  }
});

// Row operations
app.post('/api/row/add', async (req, res) => {
  const { tableName, row } = req.body;
  
  try {
    if (!tables[tableName]) {
      return res.json({ success: false, error: `Table ${tableName} not found` });
    }
    
    const table = tables[tableName];
    const fileName = path.basename(table.originalFile, '.CSV');
    
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
    
    // Run INIT rules
    const rules = await loadRules(fileName);
    const initRules = rules.filter(r => r.operation === 'INIT');
    const evaluator = new ExpressionEvaluator(row, tables, tableName);
    
    for (const rule of initRules) {
      try {
        const value = evaluator.evaluate(rule.expression);
        row[rule.columnName] = value;
      } catch (error) {
        // Continue with other rules
      }
    }
    
    // Validate types
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
  await logAction('Server starting');
  
  app.listen(PORT, () => {
    console.log(`CSV Editor server running on http://localhost:${PORT}`);
  });
}

startServer();

