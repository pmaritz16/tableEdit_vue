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
      commandLoggingEnabled: false,
      tableWidth: 0,
      commands: [
        'ADD_COLUMN',
        'COLLAPSE_TABLE',
        'COPY_TABLE',
        'DELETE_ROW',
        'DELETE_TABLE',
        'DROP_COLUMN',
        'JOIN_TABLE',
        'RENAME_TABLE',
        'REPLACE_TEXT',
        'SAVE_TABLE',
        'SORT_TABLE'
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
        case 'DROP_COLUMN':
        case 'REPLACE_TEXT':
          return this.commandParams.columnName;
        case 'RENAME_TABLE':
        case 'COPY_TABLE':
          return this.commandParams.newName;
        case 'DELETE_ROW':
          return this.commandParams.expression;
        case 'COLLAPSE_TABLE':
          return true; // columnName is optional
        case 'ADD_COLUMN':
          return this.commandParams.columnName && this.commandParams.expression;
        case 'JOIN_TABLE':
          return this.commandParams.tableName1 && this.commandParams.joinColumn;
        case 'SORT_TABLE':
          return this.commandParams.columnName;
        case 'SAVE_TABLE':
        case 'DELETE_TABLE':
          return true;
        default:
          return false;
      }
    }
  },
  mounted() {
    this.loadTables();
    this.checkLoggingStatus();
    this.replayCommands();
  },
  methods: {
    async loadTables() {
      try {
        const response = await fetch('/api/tables');
        const data = await response.json();
        if (data.success) {
          this.tables = data.tables;
          this.tableNames = Object.keys(data.tables);
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
      if (this.$refs.tableContent) {
        const table = this.$refs.tableContent.querySelector('table');
        if (table) {
          this.tableWidth = table.scrollWidth;
        }
      }
    },
    syncScroll(event) {
      const source = event.target;
      const target = source === this.$refs.topScrollbar ? this.$refs.tableContent : this.$refs.topScrollbar;
      if (target) {
        target.scrollLeft = source.scrollLeft;
      }
    },
    formatReal(value) {
      if (value === null || value === undefined) return '0.00';
      const num = parseFloat(value);
      if (isNaN(num)) return '0.00';
      return num.toFixed(2);
    },
    selectRow(index) {
      this.selectedRowIndex = index;
    },
    onCommandSelect() {
      if (this.selectedCommand) {
        this.commandParams = {};
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
      if (!this.canExecuteCommand || !this.currentTable) return;
      
      this.commandError = '';
      this.commandSuccess = '';
      
      try {
        const response = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: this.selectedCommand,
            tableName: this.currentTable,
            params: this.commandParams
          })
        });
        
        const data = await response.json();
        if (data.success) {
          this.commandSuccess = 'Command executed successfully';
          if (data.table) {
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
          setTimeout(() => {
            this.closeCommandModal();
            this.loadTables();
          }, 1000);
        } else {
          this.commandError = data.error || 'Command failed';
        }
      } catch (error) {
        this.commandError = error.message || 'Failed to execute command';
      }
    },
    async addRow() {
      if (!this.currentTableData) return;
      
      this.rowModalMode = 'add';
      this.rowData = {};
      this.rowErrors = [];
      this.rowError = '';
      
      // Initialize with default values
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
      
      this.showRowModal = true;
    },
    async editRow() {
      if (!this.currentTableData || this.selectedRowIndex === null) return;
      
      this.rowModalMode = 'edit';
      this.rowData = { ...this.currentTableData.rows[this.selectedRowIndex] };
      this.rowErrors = [];
      this.rowError = '';
      
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
      this.showRowModal = false;
      this.rowData = {};
      this.rowErrors = [];
      this.rowError = '';
    },
    async saveRow() {
      if (!this.currentTableData) return;
      
      this.rowErrors = [];
      this.rowError = '';
      
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
          if (data.errors && data.errors.length > 0) {
            this.rowErrors = data.errors;
            this.rowError = 'Validation errors occurred';
          } else {
            this.rowError = data.error || 'Failed to save row';
          }
        }
      } catch (error) {
        this.rowError = error.message || 'Failed to save row';
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
          await this.loadTables();
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
          
          for (const cmd of data.commands) {
            if (errorOccurred) break;
            
            try {
              const cmdResponse = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command: cmd.command,
                  tableName: cmd.tableName,
                  params: cmd.params
                })
              });
              
              const cmdData = await cmdResponse.json();
              if (cmdData.success) {
                successCount++;
              } else {
                errorOccurred = true;
                alert(`Error replaying command ${cmd.command}: ${cmdData.error}`);
                break;
              }
            } catch (error) {
              errorOccurred = true;
              alert(`Error replaying command ${cmd.command}: ${error.message}`);
              break;
            }
          }
          
          if (!errorOccurred && successCount > 0) {
            alert(`Successfully replayed ${successCount} commands`);
            await this.loadTables();
          }
        }
      } catch (error) {
        // No commands file or error reading - that's okay
      }
    }
  }
}).mount('#app');

