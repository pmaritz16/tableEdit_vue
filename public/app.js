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
  async mounted() {
    this.checkLoggingStatus();
    await this.loadTables();
    await this.replayCommands();
    // Update table width on window resize
    window.addEventListener('resize', () => {
      this.updateTableWidth();
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
          
          // Handle new table creation (e.g., COPY_TABLE, COLLAPSE_TABLE) BEFORE reloading
          if (data.newTableName) {
            // Ensure the table data is set before switching to it
            if (data.table) {
              this.tables[data.newTableName] = data.table;
            }
            this.tableNames = Object.keys(this.tables);
            // Optionally switch to the new table
            if (this.selectedCommand === 'COPY_TABLE' && data.table) {
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
          
          // Only reload tables if it's not a COPY_TABLE (which creates in-memory only tables)
          setTimeout(() => {
            this.closeCommandModal();
            if (this.selectedCommand !== 'COPY_TABLE') {
              this.loadTables();
            } else {
              // For COPY_TABLE, just refresh the table list without reloading from disk
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
          await this.replayCommands();
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
    }
  }
}).mount('#app');

