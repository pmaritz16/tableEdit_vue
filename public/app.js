const { createApp } = Vue;

createApp({
  data() {
    return {
      tables: {},
      tableNames: [],
      currentTable: '',
      currentTableData: null,
      selectedCommand: '',
      selectedRowIndex: null,
      showCommandModal: false,
      showRowModal: false,
      rowModalMode: 'add',
      commandParams: {},
      commandError: '',
      commandSuccess: '',
      rowData: {},
      rowErrors: [],
      rowError: '',
      rowValidationMessage: '',
      commandLoggingEnabled: false,
      tableWidth: 0,
      tags: [],
      showTagMenu: false,
      tagMenuRowIndex: null,
      tagMenuPosition: { x: 0, y: 0 },
      tagFilter: '',
      selectedTagIndex: 0,
      commands: [
        'ADD_COLUMN',
        'COLLAPSE_TABLE',
        'CONVERT_COLUMN',
        'COPY_TABLE',
        'DELETE_ROWS',
        'DELETE_TABLE',
        'DROP_COLUMNS',
        'GROUP_TABLE',
        'JOIN_TABLE',
        'REORDER_COLUMNS',
        'RENAME_COLUMN',
        'RENAME_TABLE',
        'REPLACE_TEXT',
        'SAVE_TABLE',
        'SET_VALUE',
        'SORT_TABLE',
        'SPLICE_TABLES'
      ]
    };
  },
  computed: {
    sortedCommands() {
      return [...this.commands].sort();
    },
    textColumns() {
      if (!this.currentTableData) return [];
      return this.currentTableData.schema.filter(col => col.type === 'TEXT');
    },
    canExecuteCommand() {
      if (!this.selectedCommand) return false;
      
      switch (this.selectedCommand) {
        case 'DROP_COLUMNS':
          return this.commandParams.selectedColumns && this.commandParams.selectedColumns.length > 0;
        case 'REPLACE_TEXT':
          return this.commandParams.columnName;
        case 'RENAME_COLUMN':
          return this.commandParams.oldColumnName && this.commandParams.newColumnName;
        case 'RENAME_TABLE':
        case 'COPY_TABLE':
          return this.commandParams.newName;
        case 'DELETE_ROWS':
          return this.commandParams.expression;
        case 'COLLAPSE_TABLE':
          return this.commandParams.newName; // newName is required
        case 'ADD_COLUMN':
          return this.commandParams.columnName && this.commandParams.columnType && this.commandParams.expression;
        case 'SET_VALUE':
          return this.commandParams.columnName && this.commandParams.expression;
        case 'JOIN_TABLE':
          return this.commandParams.newName && this.commandParams.tableName1 && this.commandParams.joinColumn;
        case 'SORT_TABLE':
          return this.commandParams.columnName;
        case 'GROUP_TABLE':
          return this.commandParams.newName && this.commandParams.groupColumn && this.commandParams.columnsText;
        case 'REORDER_COLUMNS':
          return this.commandParams.columnsText;
        case 'CONVERT_COLUMN':
          return this.commandParams.columnName;
        case 'SPLICE_TABLES':
          return this.commandParams.newName && this.commandParams.selectedTables && this.commandParams.selectedTables.length > 0;
        case 'SAVE_TABLE':
        case 'DELETE_TABLE':
          return true;
        default:
          return false;
      }
    }
  },
  async mounted() {
    this.checkLoggingStatus();
    await this.loadTables();
    await this.replayCommands();
    await this.loadTags();
    // Update table width on window resize
    window.addEventListener('resize', () => {
      this.updateTableWidth();
    });
    // Close tag menu when clicking outside
    document.addEventListener('click', (e) => {
      if (this.showTagMenu && !e.target.closest('.tag-menu')) {
        this.showTagMenu = false;
        this.tagMenuRowIndex = null;
        this.tagFilter = '';
        this.selectedTagIndex = 0;
      }
    });
    
    // Handle keyboard input for tag menu
    document.addEventListener('keydown', (e) => {
      if (this.showTagMenu) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const filteredTags = this.getFilteredTags();
          if (filteredTags.length > 0 && this.selectedTagIndex < filteredTags.length) {
            this.selectTag(filteredTags[this.selectedTagIndex]);
          }
        } else if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
          e.preventDefault();
          this.tagFilter += e.key.toLowerCase();
          // Reset selection to first match
          this.selectedTagIndex = 0;
          // Auto-select if filter matches exactly one tag
          const filteredTags = this.getFilteredTags();
          if (filteredTags.length === 1) {
            this.selectedTagIndex = 0;
          }
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          this.tagFilter = this.tagFilter.slice(0, -1);
          this.selectedTagIndex = 0;
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.showTagMenu = false;
          this.tagMenuRowIndex = null;
          this.tagFilter = '';
          this.selectedTagIndex = 0;
        }
      }
    });
  },
  methods: {
    async loadTables() {
      try {
        const response = await fetch('/api/tables');
        const data = await response.json();
        if (data.success) {
          // Merge server tables with any in-memory tables (like copied tables)
          const serverTables = data.tables;
          // Preserve any tables that exist in memory but not on disk
          for (const [name, table] of Object.entries(this.tables)) {
            if (!serverTables[name]) {
              serverTables[name] = table;
            }
          }
          this.tables = serverTables;
          this.tableNames = Object.keys(this.tables);
          if (this.tableNames.length > 0 && !this.currentTable) {
            this.currentTable = this.tableNames[0];
            this.onTableChange();
          }
        }
      } catch (error) {
        console.error('Failed to load tables:', error);
      }
    },
    onTableChange() {
      if (this.currentTable && this.tables[this.currentTable]) {
        this.currentTableData = this.tables[this.currentTable];
        this.selectedRowIndex = null;
        this.$nextTick(() => {
          this.updateTableWidth();
        });
      }
    },
    updateTableWidth() {
      this.$nextTick(() => {
        if (this.$refs.tableContent) {
          const table = this.$refs.tableContent.querySelector('table');
          if (table) {
            this.tableWidth = table.scrollWidth;
            // Ensure both scrollbars have the same scrollable width
            if (this.$refs.topScrollbar) {
              const spacer = this.$refs.topScrollbar.querySelector('div');
              if (spacer) {
                spacer.style.width = table.scrollWidth + 'px';
              }
            }
          }
        }
      });
    },
    syncScrollTop(event) {
      if (this.$refs.tableContent) {
        this.$refs.tableContent.scrollLeft = event.target.scrollLeft;
      }
    },
    syncScrollBottom(event) {
      if (this.$refs.topScrollbar) {
        this.$refs.topScrollbar.scrollLeft = event.target.scrollLeft;
      }
    },
    formatReal(value) {
      if (value === null || value === undefined) return '0.0';
      const num = parseFloat(value);
      if (isNaN(num)) return '0.0';
      return num.toFixed(1);
    },
    selectRow(index) {
      this.selectedRowIndex = index;
    },
    onCommandSelect() {
      if (this.selectedCommand) {
        this.commandParams = {};
        // Initialize selectedTables as empty array for SPLICE_TABLES
        if (this.selectedCommand === 'SPLICE_TABLES') {
          this.commandParams.selectedTables = [];
        }
        // Initialize selectedColumns as empty array for DROP_COLUMNS
        if (this.selectedCommand === 'DROP_COLUMNS') {
          this.commandParams.selectedColumns = [];
        }
        // Initialize column name fields for RENAME_COLUMN
        if (this.selectedCommand === 'RENAME_COLUMN') {
          this.commandParams.oldColumnName = '';
          this.commandParams.newColumnName = '';
        }
        this.commandError = '';
        this.commandSuccess = '';
        this.showCommandModal = true;
      }
    },
    closeCommandModal() {
      this.showCommandModal = false;
      this.selectedCommand = '';
      this.commandParams = {};
      this.commandError = '';
      this.commandSuccess = '';
    },
    async executeCommand() {
      if (!this.canExecuteCommand) return;
      // SPLICE_TABLES doesn't require a current table
      if (this.selectedCommand !== 'SPLICE_TABLES' && !this.currentTable) return;
      
      this.commandError = '';
      this.commandSuccess = '';
      
      // Process command params - convert comma-separated strings to arrays where needed
      const processedParams = { ...this.commandParams };
      if (this.selectedCommand === 'GROUP_TABLE' || this.selectedCommand === 'REORDER_COLUMNS') {
        if (processedParams.columnsText) {
          processedParams.columns = processedParams.columnsText.split(',').map(c => c.trim()).filter(c => c);
          delete processedParams.columnsText;
        }
      }
      // DROP_COLUMNS now uses selectedColumns array directly
      if (this.selectedCommand === 'DROP_COLUMNS') {
        if (processedParams.selectedColumns) {
          processedParams.columns = processedParams.selectedColumns;
          delete processedParams.selectedColumns;
        }
      }
      
      try {
        // SPLICE_TABLES doesn't use tableName parameter
        const requestBody = {
          command: this.selectedCommand,
          params: processedParams
        };
        if (this.selectedCommand !== 'SPLICE_TABLES') {
          requestBody.tableName = this.currentTable;
        }
        
        const response = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        if (data.success) {
          this.commandSuccess = 'Command executed successfully';
          
          // Handle table deletion - remove from tables object and update UI
          if (this.selectedCommand === 'DELETE_TABLE') {
            const deletedTableName = this.currentTable;
            // Remove table from tables object
            if (this.tables[deletedTableName]) {
              delete this.tables[deletedTableName];
            }
            // Update table list
            this.tableNames = Object.keys(this.tables);
            // Clear current table if it was the deleted one
            if (this.currentTable === deletedTableName) {
              this.currentTable = '';
              this.currentTableData = null;
              this.selectedRowIndex = null;
            }
          }
          // Handle table rename - update local tables object and switch to new name
          else if (this.selectedCommand === 'RENAME_TABLE' && data.newTableName) {
            const oldTableName = this.currentTable;
            // Update the tables object: move data from old name to new name
            if (this.tables[oldTableName]) {
              this.tables[data.newTableName] = this.tables[oldTableName];
              delete this.tables[oldTableName];
            }
            // Update table list and current selection
            this.tableNames = Object.keys(this.tables);
            this.currentTable = data.newTableName;
            this.currentTableData = this.tables[data.newTableName];
            this.$nextTick(() => {
              this.updateTableWidth();
            });
          }
          // Handle new table creation (e.g., COPY_TABLE, COLLAPSE_TABLE, GROUP_TABLE, SPLICE_TABLES) BEFORE reloading
          else if (data.newTableName) {
            // Ensure the table data is set before switching to it
            if (data.table) {
              this.tables[data.newTableName] = data.table;
            }
            this.tableNames = Object.keys(this.tables);
            // Switch to the new table for COPY_TABLE, COLLAPSE_TABLE, GROUP_TABLE, JOIN_TABLE, and SPLICE_TABLES
            if ((this.selectedCommand === 'COPY_TABLE' || this.selectedCommand === 'COLLAPSE_TABLE' || this.selectedCommand === 'GROUP_TABLE' || this.selectedCommand === 'JOIN_TABLE' || this.selectedCommand === 'SPLICE_TABLES') && data.table) {
              this.currentTable = data.newTableName;
              this.currentTableData = data.table;
              this.$nextTick(() => {
                this.updateTableWidth();
              });
            }
          }
          
          if (data.table && !data.newTableName) {
            this.currentTableData = data.table;
            this.tables[this.currentTable] = data.table;
            this.$nextTick(() => {
              this.updateTableWidth();
            });
          }
          
          if (data.tableName) {
            this.currentTable = data.tableName;
            this.tableNames = Object.keys(this.tables);
            this.onTableChange();
          }
          
          // Update table list if needed (for new tables)
          if (data.newTableName && this.selectedCommand !== 'RENAME_TABLE') {
            this.tableNames = Object.keys(this.tables);
          }
          
          setTimeout(() => {
            this.closeCommandModal();
            // Don't reload from disk - we already have the updated data from the command response
            // Only refresh the table list if a new table was created
            if (data.newTableName) {
              this.tableNames = Object.keys(this.tables);
            }
          }, 1000);
        } else {
          this.commandError = data.error || 'Command failed';
        }
      } catch (error) {
        this.commandError = error.message || 'Failed to execute command';
      }
    },
    async addRow() {
      if (!this.currentTableData || !this.currentTable) return;
      
      this.rowModalMode = 'add';
      this.rowData = {};
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
      
      // Get initialized row from server (with INIT rules applied)
      try {
        const response = await fetch(`/api/row/init/${this.currentTable}`);
        const data = await response.json();
        if (data.success && data.row) {
          // Convert values to strings for editing
          for (const col of this.currentTableData.schema) {
            if (data.row[col.name] !== undefined) {
              this.rowData[col.name] = String(data.row[col.name]);
            } else {
              // Fallback to defaults if not in response
              switch (col.type) {
                case 'INT':
                  this.rowData[col.name] = '0';
                  break;
                case 'REAL':
                  this.rowData[col.name] = '0.0';
                  break;
                default:
                  this.rowData[col.name] = '';
              }
            }
          }
        } else {
          // Fallback to default initialization if API fails
          for (const col of this.currentTableData.schema) {
            switch (col.type) {
              case 'INT':
                this.rowData[col.name] = '0';
                break;
              case 'REAL':
                this.rowData[col.name] = '0.0';
                break;
              default:
                this.rowData[col.name] = '';
            }
          }
        }
      } catch (error) {
        // Fallback to default initialization if API fails
        console.error('Failed to get initialized row:', error);
        for (const col of this.currentTableData.schema) {
          switch (col.type) {
            case 'INT':
              this.rowData[col.name] = '0';
              break;
            case 'REAL':
              this.rowData[col.name] = '0.0';
              break;
            default:
              this.rowData[col.name] = '';
          }
        }
      }
      
      this.showRowModal = true;
    },
    async editRow() {
      if (!this.currentTableData || this.selectedRowIndex === null) return;
      
      this.rowModalMode = 'edit';
      this.rowData = { ...this.currentTableData.rows[this.selectedRowIndex] };
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
      
      // Convert values to strings for editing
      for (const col of this.currentTableData.schema) {
        if (this.rowData[col.name] !== undefined) {
          this.rowData[col.name] = String(this.rowData[col.name]);
        }
      }
      
      this.showRowModal = true;
    },
    async deleteRow() {
      if (!this.currentTable || this.selectedRowIndex === null) return;
      
      if (!confirm('Are you sure you want to delete this row?')) return;
      
      try {
        const response = await fetch('/api/row/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tableName: this.currentTable,
            rowIndex: this.selectedRowIndex
          })
        });
        
        const data = await response.json();
        if (data.success) {
          this.currentTableData = data.table;
          this.tables[this.currentTable] = data.table;
          this.selectedRowIndex = null;
        } else {
          alert('Failed to delete row: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    },
    closeRowModal() {
      // Don't close if there are validation errors - user needs to fix them
      // This prevents accidental closing (click outside, X button) when errors exist
      if (this.rowErrors.length > 0 || this.rowError) {
        return;
      }
      this.showRowModal = false;
      this.rowData = {};
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
    },
    cancelRowModal() {
      // Always allow cancel - clear errors and close
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
      this.showRowModal = false;
      this.rowData = {};
    },
    async validateRow() {
      if (!this.currentTableData || this.rowModalMode !== 'add') return;
      
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
      
      // Convert row data to proper types
      const processedRow = {};
      for (const col of this.currentTableData.schema) {
        let value = this.rowData[col.name] || '';
        switch (col.type) {
          case 'INT':
            value = parseInt(value, 10);
            if (isNaN(value)) {
              this.rowErrors.push(col.name);
              this.rowError = 'Invalid integer value';
            }
            break;
          case 'REAL':
            value = parseFloat(value);
            if (isNaN(value)) {
              this.rowErrors.push(col.name);
              this.rowError = 'Invalid real value';
            }
            break;
          default:
            value = String(value);
        }
        processedRow[col.name] = value;
      }
      
      if (this.rowErrors.length > 0) {
        return;
      }
      
      try {
        const response = await fetch('/api/row/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tableName: this.currentTable,
            row: processedRow
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          // All validations passed
          this.rowValidationMessage = '✅ All validations passed!';
          this.rowErrors = [];
          this.rowError = '';
          
          // Update row data with FIXUP results (convert back to strings for display)
          if (data.row) {
            for (const col of this.currentTableData.schema) {
              if (data.row[col.name] !== undefined) {
                this.rowData[col.name] = String(data.row[col.name]);
              }
            }
          }
        } else {
          // Validation failed
          if (data.errors && data.errors.length > 0) {
            this.rowErrors = data.errors;
            const failedColumns = data.errors.join(', ');
            this.rowError = `Validation failed for: ${failedColumns}`;
            this.rowValidationMessage = `❌ Validation failed for ${data.errors.length} column(s)`;
          } else {
            this.rowError = data.error || 'Validation failed';
            this.rowValidationMessage = `❌ ${this.rowError}`;
          }
          
          // Still update row data with FIXUP results if available
          if (data.row) {
            for (const col of this.currentTableData.schema) {
              if (data.row[col.name] !== undefined) {
                this.rowData[col.name] = String(data.row[col.name]);
              }
            }
          }
        }
      } catch (error) {
        console.error(`[FRONTEND] Validation error:`, error);
        this.rowError = error.message || 'Failed to validate row';
        this.rowValidationMessage = `❌ ${this.rowError}`;
      }
    },
    async saveRow() {
      if (!this.currentTableData) return;
      
      this.rowErrors = [];
      this.rowError = '';
      this.rowValidationMessage = '';
      
      // Convert row data to proper types
      const processedRow = {};
      for (const col of this.currentTableData.schema) {
        let value = this.rowData[col.name] || '';
        switch (col.type) {
          case 'INT':
            value = parseInt(value, 10);
            if (isNaN(value)) {
              this.rowErrors.push(col.name);
              this.rowError = 'Invalid integer value';
            }
            break;
          case 'REAL':
            value = parseFloat(value);
            if (isNaN(value)) {
              this.rowErrors.push(col.name);
              this.rowError = 'Invalid real value';
            }
            break;
          default:
            value = String(value);
        }
        processedRow[col.name] = value;
      }
      
      if (this.rowErrors.length > 0) {
        return;
      }
      
      try {
        const endpoint = this.rowModalMode === 'add' ? '/api/row/add' : '/api/row/update';
        const body = {
          tableName: this.currentTable,
          row: processedRow
        };
        
        if (this.rowModalMode === 'edit') {
          body.rowIndex = this.selectedRowIndex;
        }
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        const data = await response.json();
        if (data.success) {
          this.currentTableData = data.table;
          this.tables[this.currentTable] = data.table;
          this.$nextTick(() => {
            this.updateTableWidth();
          });
          this.closeRowModal();
          if (this.rowModalMode === 'add') {
            this.selectedRowIndex = null;
          }
        } else {
          // Handle validation errors - keep modal open and show errors
          if (data.errors && data.errors.length > 0) {
            this.rowErrors = data.errors;
            // Create a more descriptive error message listing the failed columns
            const failedColumns = data.errors.join(', ');
            this.rowError = `Validation failed for the following columns: ${failedColumns}. Please correct the values and try again.`;
          } else {
            this.rowError = data.error || 'Failed to save row';
          }
          // Modal stays open - don't call closeRowModal()
        }
      } catch (error) {
        // Network or parsing errors - keep modal open and show error
        this.rowError = error.message || 'Failed to save row. Please check your connection and try again.';
        // Modal stays open - don't call closeRowModal()
      }
    },
    async restart() {
      if (!confirm('Are you sure you want to restart? All unsaved changes will be lost.')) return;
      
      try {
        const response = await fetch('/api/restart', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          this.tables = {};
          this.tableNames = [];
          this.currentTable = '';
          this.currentTableData = null;
          this.selectedRowIndex = null;
          this.selectedCommand = '';
          // Reset command logging to OFF (same as cold start)
          this.commandLoggingEnabled = false;
          await this.loadTables();
          await this.replayCommands();
          await this.loadTags();
          alert('Application restarted');
        }
      } catch (error) {
        alert('Failed to restart: ' + error.message);
      }
    },
    async toggleLogging() {
      try {
        const endpoint = this.commandLoggingEnabled ? '/api/logging/enable' : '/api/logging/disable';
        await fetch(endpoint, { method: 'POST' });
      } catch (error) {
        console.error('Failed to toggle logging:', error);
      }
    },
    async checkLoggingStatus() {
      try {
        const response = await fetch('/api/logging/status');
        const data = await response.json();
        this.commandLoggingEnabled = data.enabled;
      } catch (error) {
        console.error('Failed to check logging status:', error);
      }
    },
    async saveCommandsLog() {
      try {
        await fetch('/api/commands/save', { method: 'POST' });
        alert('Commands log saved');
      } catch (error) {
        alert('Failed to save log: ' + error.message);
      }
    },
    async clearCommandsLog() {
      if (!confirm('Are you sure you want to clear the commands log?')) return;
      
      try {
        const response = await fetch('/api/commands/clear', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          alert('Commands log cleared');
        }
      } catch (error) {
        alert('Failed to clear log: ' + error.message);
      }
    },
    async replayCommands() {
      try {
        const response = await fetch('/api/commands/replay');
        const data = await response.json();
        if (data.success && data.commands && data.commands.length > 0) {
          let errorOccurred = false;
          let successCount = 0;
          let errorMessage = '';
          
          for (const cmd of data.commands) {
            if (errorOccurred) break;
            
            try {
              const cmdResponse = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command: cmd.command,
                  tableName: cmd.tableName,
                  params: cmd.params || {}
                })
              });
              
              const cmdData = await cmdResponse.json();
              if (cmdData.success) {
                successCount++;
                // Update local table state if command returned table data
                if (cmdData.table && cmd.tableName) {
                  this.tables[cmd.tableName] = cmdData.table;
                  if (this.currentTable === cmd.tableName) {
                    this.currentTableData = cmdData.table;
                    this.$nextTick(() => {
                      this.updateTableWidth();
                    });
                  }
                }
                // Handle table name changes
                if (cmdData.tableName && cmdData.tableName !== cmd.tableName) {
                  this.tableNames = Object.keys(this.tables);
                  if (this.currentTable === cmd.tableName) {
                    this.currentTable = cmdData.tableName;
                    this.onTableChange();
                  }
                }
              } else {
                errorOccurred = true;
                errorMessage = `Error replaying command ${cmd.command}${cmd.tableName ? ' on table ' + cmd.tableName : ''}: ${cmdData.error || 'Unknown error'}`;
                break;
              }
            } catch (error) {
              errorOccurred = true;
              errorMessage = `Error replaying command ${cmd.command}${cmd.tableName ? ' on table ' + cmd.tableName : ''}: ${error.message}`;
              break;
            }
          }
          
          // Reload all tables to ensure consistency
          await this.loadTables();
          
          if (errorOccurred) {
            alert(errorMessage);
          } else if (successCount > 0) {
            // Only show success message, don't use alert for non-errors
            console.log(`Successfully replayed ${successCount} commands`);
          }
        }
      } catch (error) {
        // No commands file or error reading - that's okay, just log it
        console.log('No commands file found or error reading commands file');
      }
    },
    async loadTags() {
      try {
        const response = await fetch('/api/tags');
        const data = await response.json();
        if (data.success) {
          this.tags = data.tags;
        }
      } catch (error) {
        console.error('Failed to load tags:', error);
      }
    },
    showTagContextMenu(event, rowIndex) {
      event.preventDefault();
      event.stopPropagation();
      
      // Load tags if not already loaded
      if (this.tags.length === 0) {
        this.loadTags();
      }
      
      this.tagMenuRowIndex = rowIndex;
      this.tagMenuPosition = { x: event.clientX, y: event.clientY };
      this.showTagMenu = true;
      this.tagFilter = '';
      this.selectedTagIndex = 0;
    },
    async selectTag(tag) {
      if (this.tagMenuRowIndex === null || !this.currentTable) {
        return;
      }
      
      try {
        const response = await fetch('/api/row/tag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tableName: this.currentTable,
            rowIndex: this.tagMenuRowIndex,
            tag: tag
          })
        });
        
        const data = await response.json();
        if (data.success) {
          this.currentTableData = data.table;
          this.tables[this.currentTable] = data.table;
          this.$nextTick(() => {
            this.updateTableWidth();
          });
        } else {
          alert('Failed to tag row: ' + (data.error || 'Unknown error'));
        }
      } catch (error) {
        alert('Failed to tag row: ' + error.message);
      }
      
      this.showTagMenu = false;
      this.tagMenuRowIndex = null;
      this.tagFilter = '';
      this.selectedTagIndex = 0;
    },
    getFilteredTags() {
      if (!this.tagFilter) {
        return this.tags;
      }
      const filter = this.tagFilter.toLowerCase();
      return this.tags.filter(tag => 
        tag.toLowerCase().startsWith(filter)
      );
    }
  }
}).mount('#app');

