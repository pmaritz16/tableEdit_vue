# CSV Editor (csvedit)

A comprehensive CSV file editor built with Vue.js frontend and Node.js/Express backend.

## Features

- Load and display CSV files from the `Data` directory
- Schema detection from first line (columnName:columnType format)
- Data cleaning (truncate long lines, pad short lines, clean REAL values)
- Table operations: Add, Edit, Delete rows
- Command menu with operations:
  - SAVE_TABLE
  - DROP_COLUMN
  - RENAME_TABLE
  - DELETE_ROW (with expression)
  - COLLAPSE_TABLE (grouping and summing)
  - REPLACE_TEXT (regex replacement)
  - ADD_COLUMN (with expression)
  - JOIN_TABLE
  - COPY_TABLE
  - SORT_TABLE
  - DELETE_TABLE
- Augmented expression evaluator with arithmetic, boolean, comparison, and special functions
- Rules engine (.RUL files) for INIT, FIXUP, and CHECK operations
- Command logging (optional) with replay capability
- Horizontal scrolling tables with top scrollbar
- Restart functionality

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser to `http://localhost:3000`

## CSV File Format

CSV files should be placed in the `Data` directory with `.CSV` extension (uppercase).

The first line should contain the schema in the format:
```
columnName1:columnType1,columnName2:columnType2,...
```

Column types can be:
- `TEXT` (default if not specified)
- `INT`
- `REAL`

Example:
```
Name:TEXT,Age:INT,Salary:REAL
John,30,50000.50
Jane,25,60000.75
```

## Rules Files (.RUL)

Create a `.RUL` file with the same base name as your CSV file to define rules for row operations.

Format:
```
OPERATION columnName expression
```

Operations:
- `INIT` - Initialize field value before adding a row
- `FIXUP` - Modify field value after user input
- `CHECK` - Validate field value (error if expression returns 0)

Example (`sample.RUL`):
```
INIT CreatedDate TODAY()
FIXUP Name UPPER(Name)
CHECK Age Age > 0
```

## Augmented Expressions

Expressions support:
- Arithmetic: `+`, `-`, `*`, `/`, `^`
- Boolean: `&&`, `||`, `!`
- Comparisons: `<`, `=`, `>`
- Conditional: `condition ? trueValue : falseValue`
- Functions: `BLANK(field)`, `TODAY()`, `DAY()`, `MONTH()`, `YEAR()`, `NOW()`, `LENGTH(string)`, `APPEND(str1, str2)`, `UPPER(string)`
- Field references by column name
- Constants: numbers, single-quoted strings

## Logging

- All actions and errors are logged to `main.log`
- Command logging (optional) writes to `Data/commands.txt`
- Commands are automatically replayed on startup if `commands.txt` exists

## Usage

1. Place your CSV files in the `Data` directory
2. Select a table from the dropdown
3. Use the command menu to perform operations
4. Click "Add Row" or "Edit Row" to modify data
5. Use the restart button to reset the application






