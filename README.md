# CSV Editor (csvedit) - Complete Documentation

A comprehensive CSV file editor built with Vue.js frontend and Node.js/Express backend. This document provides complete information to re-implement the program from scratch.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Startup and File Processing](#startup-and-file-processing)
3. [CSV File Format](#csv-file-format)
4. [Commands](#commands)
5. [Augmented Expression Language](#augmented-expression-language)
6. [Functions](#functions)
7. [Operators and Precedence](#operators-and-precedence)
8. [Field References](#field-references)
9. [Rules Engine (.RUL Files)](#rules-engine-rul-files)
10. [Tagging System](#tagging-system)
11. [Logging](#logging)
12. [API Endpoints](#api-endpoints)

---

## Architecture Overview

- **Frontend**: Vue.js 3 application (`public/index.html`, `public/app.js`)
- **Backend**: Node.js/Express server (`server.js`)
- **Port**: 3000 (default)
- **Data Directory**: `Data/` (relative to server root)
- **Log Files**: `main.log` (root), `Data/commands.txt` (command log)

---

## Startup and File Processing

### Server Startup Sequence

1. **Create Data Directory**: Ensures `Data/` directory exists
2. **Initialize Log File**: Deletes and recreates `main.log` (empty file)
3. **Load CSV Files**: Scans `Data/` directory for `.CSV` files
4. **Load Rules**: For each CSV file, attempts to load corresponding `.RUL` file
5. **Load Tags**: Reads `Data/commands.tag` file (if exists)
6. **Start Express Server**: Listens on port 3000

### Startup Files

#### CSV Files (`*.CSV`)

- **Location**: `Data/` directory
- **Extension**: Must be `.CSV` (uppercase)
- **Format**: See [CSV File Format](#csv-file-format) section
- **Processing**: 
  - First line contains schema: `columnName:columnType,columnName:columnType,...`
  - Subsequent lines contain data rows
  - Lines are parsed, cleaned, and loaded into memory as table objects

#### Rules Files (`*.RUL` or `*.rul`)

- **Location**: `Data/` directory
- **Naming**: Must match CSV base filename (case-insensitive)
  - Example: `sample.CSV` → `sample.RUL` or `sample.rul`
- **Format**: See [Rules Engine](#rules-engine-rul-files) section
- **Processing**: 
  - Loaded on-demand when rows are added/edited
  - Rules are executed in order: INIT → FIXUP → CHECK
  - Missing files return empty rules array (no error)

#### Tags File (`commands.tag`)

- **Location**: `Data/commands.tag`
- **Format**: Plain text, one tag per line
- **Processing**:
  - Loaded on server startup
  - Re-loaded when user clicks "Restart" button
  - Used for row tagging dropdown menu
  - Missing file returns empty tags array (no error)

#### Command Log File (`commands.txt`)

- **Location**: `Data/commands.txt`
- **Format**: One command per line: `COMMAND tableName {"param":"value"}`
- **Processing**:
  - Created/updated when command logging is enabled
  - Can be replayed via `/api/commands/replay` endpoint
  - Not automatically executed on startup

---

## CSV File Format

### Schema Line (First Line)

Format: `columnName:columnType,columnName:columnType,...`

**Column Types:**
- `TEXT` - Text strings (default if type not specified)
- `INT` - Integer numbers
- `REAL` - Floating-point numbers

**Example:**
```
Name:TEXT,Age:INT,Salary:REAL
```

### Data Rows

- Comma-separated values
- Fields containing commas, quotes, or newlines must be quoted
- Quotes within quoted fields are escaped as `""`
- Missing fields are padded with empty strings
- Long lines are truncated to match schema length

### Data Cleaning

- **REAL values**: Cleaned to remove non-numeric characters except decimal point and minus sign
- **Line padding**: Short lines are padded with empty strings to match schema
- **Line truncation**: Long lines are truncated to match schema

### Default Values

When parsing values:
- `INT`: Empty/null → `0`
- `REAL`: Empty/null → `0.0`
- `TEXT`: Empty/null → `''`

### Saving Tables

- REAL values are formatted with `toFixed(1)` (at least one decimal place)
- Fields are quoted if they contain commas, quotes, or newlines
- Schema line is written first, followed by data rows

---

## Commands

All commands are executed via `POST /api/command` endpoint with:
- `command`: Command name (string)
- `tableName`: Target table name (string, optional for some commands)
- `params`: Command-specific parameters (object)

### Command List

#### SAVE_TABLE

Saves a table to CSV file in `Data/` directory.

**Parameters:**
- `tableName` (required): Name of table to save

**Behavior:**
- Creates/overwrites `{tableName}.CSV` file
- Writes schema line first
- Formats REAL values with one decimal place
- Escapes fields containing commas/quotes/newlines

**Returns:** `{success: boolean, error?: string}`

---

#### DROP_COLUMNS

Removes multiple columns from a table.

**Parameters:**
- `tableName` (required): Name of table
- `columns` (required): Array of column names to remove

**Behavior:**
- Validates all columns exist before removing any
- Removes columns from schema and all rows
- Returns error if any column not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### RENAME_COLUMN

Renames a column in a table.

**Parameters:**
- `tableName` (required): Name of table
- `oldColumnName` (required): Current column name
- `newColumnName` (required): New column name

**Behavior:**
- Updates schema and all rows
- Returns error if old column not found or new name already exists
- Old and new names must be different

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### RENAME_TABLE

Renames a table.

**Parameters:**
- `tableName` (required): Current table name
- `newName` (required): New table name

**Behavior:**
- Updates table reference in memory
- Updates `originalFile` property
- Returns error if new name already exists

**Returns:** `{success: boolean, error?: string, newTableName?: string}`

---

#### DELETE_ROWS

Deletes rows where expression evaluates to true (non-zero).

**Parameters:**
- `tableName` (required): Name of table
- `expression` (required): Augmented expression to evaluate

**Behavior:**
- Evaluates expression for each row
- Keeps rows where expression returns `0` (false)
- Deletes rows where expression returns non-zero (true)
- Non-numeric string results keep the row (safe default)
- Evaluation errors keep the row (don't delete on error)

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### COLLAPSE_TABLE

Groups rows by a TEXT column and sums INT/REAL columns. Creates a new table.

**Parameters:**
- `tableName` (required): Source table name
- `columnName` (optional): TEXT column to group by (if omitted, creates single row with totals)
- `newName` (required): Name for the new collapsed table

**Behavior:**
- Groups rows by `columnName` value (or all rows if `columnName` omitted)
- Sums all INT and REAL columns within each group
- Creates new table with group column first, then summed columns
- Returns error if `columnName` is not TEXT type or not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### REPLACE_TEXT

Replaces text in a TEXT column using regular expression.

**Parameters:**
- `tableName` (required): Name of table
- `columnName` (required): TEXT column to modify
- `regex` (required): Regular expression pattern
- `replacement` (required): Replacement string (supports `$1`, `$2` for groups, `$0` for full match)

**Behavior:**
- Applies regex replacement to all rows in specified column
- Supports replacement patterns: `$0` (full match), `$1`, `$2`, etc. (captured groups)
- Returns error if column not found or not TEXT type

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### ADD_COLUMN

Adds a new column with values computed from an expression.

**Parameters:**
- `tableName` (required): Name of table
- `columnName` (required): Name for new column
- `expression` (required): Augmented expression to evaluate for each row
- `columnType` (required): Type of new column (`TEXT`, `INT`, or `REAL`)

**Behavior:**
- Evaluates expression for each row
- Adds column to schema with specified type
- Sets row values to expression results
- No type conversion - values stored as returned by expression

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### SET_VALUE

Sets the value of an existing column using an expression.

**Parameters:**
- `tableName` (required): Name of table
- `columnName` (required): Name of column to update
- `expression` (required): Augmented expression to evaluate for each row

**Behavior:**
- Evaluates expression for each row
- Updates column value with expression result
- Returns error if column not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### JOIN_TABLE

Joins two tables on a specified column. Creates a new table.

**Parameters:**
- `tableName` (required): First table name
- `tableName1` (required): Second table name
- `joinColumn` (required): Column name to join on (must exist in both tables)
- `newName` (required): Name for the new joined table

**Behavior:**
- Performs inner join: only rows with matching `joinColumn` values
- Creates new table with all columns from both tables
- Column names from second table prefixed if duplicate names exist
- Returns error if tables or column not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### COPY_TABLE

Creates a copy of a table with a new name.

**Parameters:**
- `tableName` (required): Source table name
- `newName` (required): Name for the new table

**Behavior:**
- Creates deep copy of table (schema and rows)
- Updates `originalFile` property to new name
- Returns error if new name already exists

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### SORT_TABLE

Sorts a table by a column and order.

**Parameters:**
- `tableName` (required): Name of table
- `columnName` (required): Column to sort by
- `order` (required): `'asc'` or `'desc'`

**Behavior:**
- Sorts rows in-place by specified column
- Numeric columns sorted numerically
- TEXT columns sorted lexicographically
- Returns error if column not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### DELETE_TABLE

Deletes a table from memory.

**Parameters:**
- `tableName` (required): Name of table to delete

**Behavior:**
- Removes table from in-memory tables object
- Does not delete CSV file from disk

**Returns:** `{success: boolean, error?: string}`

---

#### GROUP_TABLE

Groups rows by a column and sums specified columns. Creates a new table.

**Parameters:**
- `tableName` (required): Source table name
- `groupColumn` (required): Column to group by
- `columns` (required): Array of column names to sum
- `newName` (required): Name for the new grouped table

**Behavior:**
- Groups rows by `groupColumn` value
- Sums specified columns within each group
- Creates new table with group column first, then summed columns
- Returns error if columns not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### REORDER_COLUMNS

Reorders columns to place specified ones first.

**Parameters:**
- `tableName` (required): Name of table
- `columns` (required): Array of column names to place first (in order)

**Behavior:**
- Reorders schema to place specified columns first
- Remaining columns follow in original order
- Returns error if any column not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### CONVERT_COLUMN

Converts a column's type (TEXT → INT/REAL, INT → REAL).

**Parameters:**
- `tableName` (required): Name of table
- `columnName` (required): Column to convert

**Behavior:**
- Attempts to parse values to target type
- Invalid values become defaults (0 for INT, 0.0 for REAL)
- Updates schema type

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

#### SPLICE_TABLES

Concatenates rows from multiple tables. Creates a new table.

**Parameters:**
- `selectedTables` (required): Array of table names to concatenate
- `newName` (required): Name for the new spliced table

**Behavior:**
- Combines all rows from selected tables
- Schema is union of all table schemas
- Missing columns in rows are set to defaults
- Returns error if no tables selected or tables not found

**Returns:** `{success: boolean, error?: string, table?: Object}`

---

## Augmented Expression Language

Expressions are evaluated using an augmented expression evaluator that supports:
- Arithmetic operations
- Boolean operations
- Comparisons
- Conditional expressions
- Function calls
- Field references
- String literals
- Numeric literals

### Expression Evaluation Order

1. **Conditional expressions** (`? :`) - rightmost pair first
2. **Function calls** - innermost to outermost
3. **Parentheses** - nested expressions
4. **Field references** - column names replaced with values
5. **String literals** - single quotes converted to double quotes
6. **Boolean operations** - `!`, then `&&`, then `||`
7. **Unary minus** - `-expression`
8. **Arithmetic operations** - `^`, then `*`/`/`, then `+`/`-`
9. **Comparisons** - `<`, `=`, `>`, `!=`

---

## Functions

Functions are called with syntax: `FUNCTION_NAME(arg1, arg2, ...)`

Function arguments are passed as raw strings (not pre-evaluated). Functions handle their own argument interpretation.

### Function List

#### BLANK(field)

Checks if a field is blank (empty, null, undefined, or 0).

**Arguments:**
- `field`: Field name (string) or value (can be quoted with single or double quotes)

**Returns:** `1` if blank, `0` if not blank

**Behavior:**
- Strips quotes from quoted arguments (handles both single and double quotes)
- Resolves unquoted strings as field names if they match a column name
- Falls back to literal string if field not found
- Checks if value is blank: empty string, null, undefined, or 0

**Example:** `BLANK(Amount)` returns `1` if Amount is empty or 0

---

#### TODAY()

Returns current date in format `YYYY/MM/DD`.

**Arguments:** None

**Returns:** String (e.g., `"2024/01/15"`)

---

#### DAY()

Returns current day of month (01-31).

**Arguments:** None

**Returns:** String (e.g., `"15"`)

---

#### MONTH()

Returns current month (01-12).

**Arguments:** None

**Returns:** String (e.g., `"01"`)

---

#### YEAR()

Returns current year (4 digits).

**Arguments:** None

**Returns:** String (e.g., `"2024"`)

---

#### NOW()

Returns current time in format `HH:MM:SS`.

**Arguments:** None

**Returns:** String (e.g., `"14:30:45"`)

---

#### LENGTH(str)

Returns the length of a string.

**Arguments:**
- `str`: String value or field name (can be quoted with single or double quotes)

**Returns:** Number (string length)

**Behavior:**
- Strips quotes from quoted arguments (handles both single and double quotes)
- Resolves unquoted strings as field names if they match a column name
- Falls back to literal string if field not found

**Example:** `LENGTH(Name)` returns length of Name field

---

#### APPEND(str1, str2)

Concatenates two strings.

**Arguments:**
- `str1`: First string (can be quoted with single or double quotes, or field name)
- `str2`: Second string (can be quoted with single or double quotes, or field name)

**Returns:** String (concatenated result)

**Behavior:**
- Strips quotes from quoted arguments (handles both single and double quotes)
- Resolves unquoted strings as field names if they match a column name
- Falls back to literal string if field not found

**Example:** 
- `APPEND("Hello", "World")` returns `"HelloWorld"`
- `APPEND('K', From)` returns `"KPAE"` if From field is "PAE"

---

#### UPPER(str)

Converts string to uppercase.

**Arguments:**
- `str`: String value or field name (can be quoted with single or double quotes)

**Returns:** String (uppercase)

**Behavior:**
- Strips quotes from quoted arguments (handles both single and double quotes)
- Resolves unquoted strings as field names if they match a column name
- Falls back to literal string if field not found

**Example:** `UPPER(Name)` returns uppercase Name field

---

#### TOTAL(tableName, columnName)

Sums all values in a column of a specified table.

**Arguments:**
- `tableName`: Name of table (string, quotes removed if present)
- `columnName`: Name of column (string, quotes removed if present)

**Returns:** Number (sum of column values)

**Behavior:**
- Sums INT and REAL columns
- TEXT columns ignored (returns 0)
- Returns 0 if table or column not found

**Example:** `TOTAL("sales", "Amount")` sums Amount column in sales table

---

#### REGEXP(pattern, str)

Applies regular expression pattern to string, returns first match or empty string.

**Arguments:**
- `pattern`: Regular expression pattern (string, single or double quotes removed)
- `str`: String to search (field name resolved to value if not quoted)

**Returns:** String (first match or `''`)

**Behavior:**
- Pattern can be single or double quoted
- If `str` is not quoted, treated as field name and resolved to value
- Invalid regex patterns return empty string (no error)

**Example:** `REGEXP('METROP', Payee)` matches "METROP" in Payee field

---

#### CURR_ROW()

Returns the 0-based index of the current row in the table.

**Arguments:** None

**Returns:** Number (row index, 0-based)

**Behavior:**
- Returns 0 if no current row or table
- Finds row by reference equality or field value comparison

**Example:** `CURR_ROW()` returns `0` for first row, `1` for second, etc.

---

#### NUM_ROWS()

Returns the total number of rows in the current table.

**Arguments:** None

**Returns:** Number (row count)

**Behavior:**
- Returns 0 if no current table

**Example:** `NUM_ROWS()` returns total row count

---

#### SUM(columnName, start, finish)

Sums values in a column from index `start` to `finish` (inclusive).

**Arguments:**
- `columnName`: Name of column to sum (string, quotes removed)
- `start`: Starting row index (0-based, can be expression)
- `finish`: Ending row index (0-based, can be expression, inclusive)

**Returns:** Number (sum of values)

**Behavior:**
- Returns 0 if `start > finish`
- Returns 0 if indices out of bounds (negative or >= table length)
- Throws error if column is TEXT type
- Evaluates `start` and `finish` as expressions if strings
- Indices are rounded to integers

**Example:** 
- `SUM(Amount, 0, 10)` sums rows 0-10
- `SUM(Amount, 0, NUM_ROWS()-1)` sums all rows

---

#### REPLACE(column1, regexp1, target1)

Replaces text in a column using a regular expression pattern and inserts matches into a target template.

**Arguments:**
- `column1`: Name of column containing source text (field name resolved to value)
- `regexp1`: Regular expression pattern (string, single or double quotes removed)
- `target1`: Replacement template (string, single or double quotes removed)

**Returns:** String (replaced text, or original if no match)

**Behavior:**
- Applies regex pattern to field value from current row
- Replaces all matches (global flag) with target template
- Supports replacement patterns: `$0` (full match), `$1`, `$2`, etc. (captured groups)
- Returns original string if no match found
- Returns empty string if regex pattern is invalid

**Example:**
- `REPLACE(Date, '(\d{2})/(\d{2})/(\d{4})', '$3-$2-$1')` converts "01/15/2024" to "2024-15-01"
- `REPLACE(Text, 'old', 'new')` replaces all occurrences of "old" with "new"

---

## Operators and Precedence

### Operator Precedence (highest to lowest)

1. **Function calls** - `FUNC(arg)`
2. **Parentheses** - `(expression)`
3. **Unary minus** - `-expression`
4. **Exponentiation** - `^` (right-associative)
5. **Multiplication/Division** - `*`, `/` (left-associative)
6. **Addition/Subtraction** - `+`, `-` (left-associative)
7. **Comparisons** - `<`, `=`, `>`, `!=` (left-associative)
8. **Boolean NOT** - `!` (right-associative)
9. **Boolean AND** - `&&` (left-associative)
10. **Boolean OR** - `||` (left-associative)
11. **Conditional** - `? :` (right-associative, rightmost pair evaluated first)

### Arithmetic Operators

- `+` - Addition
- `-` - Subtraction (binary) or negation (unary)
- `*` - Multiplication
- `/` - Division
- `^` - Exponentiation

**Type Handling:**
- Numeric operations: INT and REAL can be mixed
- String operations: `+` concatenates strings
- Type coercion: Strings are converted to numbers when possible

### Comparison Operators

- `<` - Less than
- `=` - Equal to
- `>` - Greater than
- `!=` - Not equal to

**Type Compatibility:**
- INT and REAL can be compared with each other
- TEXT can only be compared with TEXT
- Returns `1` if true, `0` if false
- Type mismatch throws error

**Numeric Detection:**
- Quoted strings are TEXT
- Unquoted values are checked for numeric parsing
- Both operands must be numeric or both TEXT

### Boolean Operators

- `!` - Logical NOT (returns 1 or 0)
- `&&` - Logical AND
- `||` - Logical OR

**Truthiness:**
- `0` is false
- Non-zero numbers are true
- Empty string `""` is false
- Non-empty strings are true

### Conditional Operator

- `condition ? trueValue : falseValue`

**Behavior:**
- Evaluates `condition`
- If condition is truthy (non-zero), returns `trueValue`
- If condition is falsy (zero), returns `falseValue`
- Rightmost `? :` pair is evaluated first

---

## Field References

### Basic Field Reference

Syntax: `columnName`

**Behavior:**
- Replaced with value from current row
- Field name must match column name exactly (case-sensitive)
- Returns field value (type preserved: INT/REAL as number, TEXT as string)

**Example:** `Amount` returns value of Amount column for current row

### Indexed Field Reference

Syntax: `columnName[offset]`

**Behavior:**
- Returns value from row at offset from current row
- `offset` can be:
  - Positive number: rows ahead (e.g., `Amount[1]` = next row)
  - Negative number: rows behind (e.g., `Amount[-1]` = previous row)
  - Zero: current row (same as `Amount[0]`)
  - Expression: evaluated to get offset value
- Out of bounds returns empty string or default value
- Processed before regular field references

**Examples:**
- `Amount[1]` - value from next row
- `Amount[-1]` - value from previous row
- `Amount[CURR_ROW()]` - value from row at current index

### Field Reference Processing Order

1. **Indexed references** (`columnName[offset]`) - processed first, rightmost brackets matched
2. **Regular references** (`columnName`) - processed after indexed references
3. **Number protection** - numeric values protected from further processing

### Field Reference in Functions

When field names are passed as function arguments:
- They are passed as raw strings (not pre-evaluated)
- Functions like `BLANK(fieldName)` resolve field names themselves
- Functions like `SUM(columnName, ...)` use column name as literal (not field value)

---

## Rules Engine (.RUL Files)

### File Format

**Location:** `Data/{filename}.RUL` or `Data/{filename}.rul` (case-insensitive)

**Format:** One rule per line
```
OPERATION columnName expression
```

**Operations:**
- `INIT` - Initialize field value before adding a row
- `FIXUP` - Modify field value after user input
- `CHECK` - Validate field value (error if expression returns 0)

### Rule Execution Order

1. **INIT rules** - Executed when initializing a new row (before user input)
2. **FIXUP rules** - Executed after user input (before validation)
3. **CHECK rules** - Executed for validation (after FIXUP)

### Rule Processing

- Rules are loaded from `.RUL` file matching CSV base filename
- Rules execute in file order
- Each rule evaluates expression and:
  - **INIT**: Sets `columnName` to expression result
  - **FIXUP**: Sets `columnName` to expression result
  - **CHECK**: If expression returns 0, marks field as error (red highlight)

### Error Handling

- **CHECK errors**: Field highlighted in red, row not saved
- **Other errors**: Logged, processing continues
- All rules execute even if errors occur
- Row is only saved if all CHECK rules pass

### Example Rules File (`sample.RUL`)

```
INIT CreatedDate TODAY()
INIT Status "New"
FIXUP Name UPPER(Name)
FIXUP Amount Amount * 1.1
CHECK Age Age > 0
CHECK Amount Amount >= 0
```

---

## Tagging System

### Tag File

**Location:** `Data/commands.tag`

**Format:** Plain text, one tag per line
```
Tag1
Tag2
Tag3
```

### Tag Column

- Column name: `tag` (lowercase)
- Type: `TEXT`
- Added automatically when first row is tagged
- All existing rows initialized with empty string when column added

### Tagging Process

1. User right-clicks on a row
2. System checks if `tag` column exists (adds if not)
3. System loads tags from `commands.tag` file (if not already loaded)
4. Dropdown menu displayed with available tags
5. User selects tag
6. Row's `tag` field updated (overwrites previous value)

### Tag Loading

- Loaded on server startup
- Re-loaded when user clicks "Restart" button
- Missing file returns empty tags array (no error)
- Tags cached in frontend after initial load

---

## Logging

### Main Log (`main.log`)

**Location:** Root directory (`main.log`)

**Format:** Timestamped entries
```
[2024-01-15T10:30:45.123Z] Server starting
[2024-01-15T10:30:46.456Z] Loading rules from Data/sample.RUL
[2024-01-15T10:30:47.789Z] ERROR: Failed to load table - Table not found
```

**Content:**
- Server startup/shutdown
- File loading operations
- Command executions
- Rule processing
- Errors and exceptions

**Lifecycle:**
- Deleted and recreated on server startup (empty file)
- Appended during operation
- No automatic rotation

### Command Log (`Data/commands.txt`)

**Location:** `Data/commands.txt`

**Format:** One command per line
```
SAVE_TABLE sales {}
ADD_COLUMN sales {"columnName":"Total","columnType":"REAL","expression":"Amount * 1.1"}
DELETE_ROWS sales {"expression":"Status = 'Deleted'"}
```

**Content:**
- Only logged when command logging is enabled
- Format: `COMMAND tableName {"param":"value"}`
- Can be replayed via API endpoint

**Lifecycle:**
- Created when first command logged (if enabled)
- Appended during operation
- Not automatically executed on startup

### Command Logging Control

- **Enable:** `POST /api/logging/enable`
- **Disable:** `POST /api/logging/disable`
- **Status:** `GET /api/logging/status`

### Console Logging

- Server startup message: `CSV Editor server running on http://localhost:3000`
- SUM function debug logs (if enabled in code)
- Error messages to console.error

---

## API Endpoints

### Table Operations

- `GET /api/tables` - Get list of all tables
- `GET /api/table/:tableName` - Get table data
- `POST /api/command` - Execute command (see Commands section)

### Row Operations

- `GET /api/row/init/:tableName` - Get initialized row data (for Add Row dialog)
- `POST /api/row/add` - Add new row
- `POST /api/row/update` - Update existing row
- `POST /api/row/delete` - Delete row
- `POST /api/row/tag` - Tag a row

### Rules

- `POST /api/rules/run` - Run rules for a row

### Commands

- `GET /api/commands/replay` - Replay commands from log file
- `POST /api/commands/save` - Save commands (already saved automatically)

### Logging

- `POST /api/logging/enable` - Enable command logging
- `POST /api/logging/disable` - Disable command logging
- `GET /api/logging/status` - Get logging status

### Tags

- `GET /api/tags` - Get list of tags from `commands.tag` file

### Restart

- `POST /api/restart` - Restart application (reloads tables, rules, tags)

---

## Implementation Notes

### Expression Evaluator

- Functions processed innermost to outermost
- Field references processed after functions
- String literals converted from single to double quotes
- All intermediate results kept as strings for regex compatibility
- Type checking done at comparison time

### Table Structure

In-memory table structure:
```javascript
{
  schema: [
    { name: "ColumnName", type: "TEXT|INT|REAL" },
    ...
  ],
  rows: [
    { ColumnName: value, ... },
    ...
  ],
  originalFile: "filename.CSV"
}
```

### Error Handling

- Command errors return `{success: false, error: "message"}`
- Expression errors throw exceptions (caught and logged)
- Missing files return empty arrays/objects (no errors)
- Invalid operations return error messages

### Type System

- **TEXT**: Stored as strings
- **INT**: Stored as numbers (integers)
- **REAL**: Stored as numbers (floats), displayed/saved with 1 decimal place
- Type conversion: Automatic for arithmetic, explicit for comparisons

---

## Complete Example

### CSV File (`Data/sales.CSV`)
```
Date:TEXT,Amount:REAL,Status:TEXT
2024-01-15,100.50,Active
2024-01-16,200.75,Active
2024-01-17,150.00,Inactive
```

### Rules File (`Data/sales.RUL`)
```
INIT Date TODAY()
FIXUP Status UPPER(Status)
CHECK Amount Amount > 0
```

### Tags File (`Data/commands.tag`)
```
Verified
Pending
Rejected
```

### Expression Examples

- `Amount * 1.1` - Multiply Amount by 1.1
- `Status = 'Active' ? Amount : 0` - Conditional
- `SUM(Amount, 0, NUM_ROWS()-1)` - Sum all amounts
- `REGEXP('Active', Status) != '' ? 1 : 0` - Pattern match
- `Amount[1]` - Amount from next row
- `CURR_ROW() < NUM_ROWS() - 1 ? 'no' : 'yes'` - Row position check

---

## End of Documentation

This document provides complete information to re-implement the CSV Editor program. All commands, functions, operators, file formats, and behaviors are documented above.
