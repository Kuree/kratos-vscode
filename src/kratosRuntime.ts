import * as Database from 'better-sqlite3'
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import * as socket_io from 'socket.io-client';

export interface KratosBreakpoint {
	id: number;
	line: number;
	filename: string;
	valid: boolean;
}


export class KratosRuntime extends EventEmitter {

	private _debugFile: string = "";
	private _db: Database.Database | undefined = undefined;
	public get debugFile() {
		return this._debugFile;
	}

	// maps from id to the actual breakpoint
	private _breakPoints = new Map<number, KratosBreakpoint>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _conn: SocketIOClient.Socket | undefined = undefined;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {
		this.loadSource(program);
		// connect to the server
		this._conn = socket_io("http://localhost:8888");

		this._conn.on("connect", () => {
			// send all breakpoints over
			this._breakPoints.forEach((bp, key, _) => {
				
			})
			// send start command
			if (stopOnEntry) {
				// it's paused by default in the simulation runtime
			} else {
				// we just start to run until we hit a breakpoint or an exception
				this.continue();
			}
		});

		// event listeners
		this._conn.on("breakpoint", (data: string) => {
			var br_id: number = parseInt(data);
			this.fireEventsForBreakPoint(br_id);
		});
		//
		
	}

	private run(is_step: Boolean) {
		if (this._conn) {
			if (!is_step) {
				// send the continue commend
				this._conn.send();
			} else {
				// send the step command
				this._conn.send();
			}
		} else {
			// inform user that it's not connected to the simulator runtime
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue() {
		this.run(false);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step() {
		this.run(true);
	}


	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(filename: string, line: number) : KratosBreakpoint {
		// get the absolute path
		var filename = path.resolve(filename);
		var bp = <KratosBreakpoint> { valid: false, line, id: this._breakpointId++, filename: filename };

		if (this._db) {
			const stmt = this._db.prepare("SELECT id FROM breakpoint WHERE filename = ? and line_num = ?");
			const row = stmt.get(filename, line);
			if (row) {
				var id = row.id;
				this._breakPoints.set(id, bp);
				if (this._conn) {
					this.sendBreakpoint(id);
				}
			}			
		}
		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(filename: string, line: number) : KratosBreakpoint | undefined {
		// get the absolute path
		var filename = path.resolve(filename);
		if (this._db) {
			const stmt = this._db.prepare("SELECT id FROM breakpoint WHERE filename = ? and line_num = ?");
			const row = stmt.get(filename, line);
			if (row) {
				const id = row.id;
				if (this._breakPoints.has(id)) {
					var bp = this._breakPoints.get(id);
					this._breakPoints.delete(id);
					// remove the id from the simulator
					this.sendRemoveBreakpoint(id);
					return bp;
				}
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(filename: string): void {
		// find the filename
		var filename = path.resolve(filename);
		if (this._db) {
			const stmt = this._db.prepare("SELECT id FROM breakpoint WHERE filename = ?");
			const rows = stmt.all(filename);
			rows.forEach((row) => {
				const id = row.id;
				if (this._breakPoints.has(id)) {
					this._breakPoints.delete(id);
					// remove the id from the simulator
					this.sendRemoveBreakpoint(id);
				}
			});
		}
	}

	public getBreakpoints(filename: string, line: number) : Array<number> {
		if (this._db) {
			const stmt = this._db.prepare("SELECT * FROM breakpoint where filename = ? and line_num = ?");
			const row = stmt.get(filename, line);
			if (row) {
				return [0];
			} else {
				return [];
			}
		}
		return [];
	}

	// private methods

	private sendBreakpoint(break_id: number) {
		if (this._conn) {
			var bp = this._breakPoints.get(break_id);
			if (bp) {
				bp.valid = true;
				this._conn.send("breakpoint_add", break_id.toString());
				// update the gui
				this.sendEvent('breakpointValidated', bp);
			}
		}
	}

	private sendRemoveBreakpoint(break_id: number) {
		if (this._conn) {
			var bp = this._breakPoints.get(break_id);
			if (bp) {
				this._conn.send("breakpoint_remove", break_id.toString());
			}
		}
	}

	private loadSource(file: string) {
		if (this._debugFile !== file) {
			this._debugFile = file;
			// load sqlite3
			// we use read only mode
			this._db = new Database(file, {readonly: true});
			// run a query to get all available breakpoints
			var bps = new Map<string, Map<number, number>>();
			const stmt = this._db.prepare("SELECT * FROM breakpoint");
			const rows = stmt.all();
			rows.forEach((row) => {
				var br_id: number = row.id;
				var filename: string = row.filename;
				var line_num: number = row.line_num;
				// open these files from the workspace
				vscode.workspace.openTextDocument(filename);
				// create maps of the break points
				if (!bps.has(filename)) {
					bps.set(filename, new Map<number, number>());
				}
				var entry = bps.get(filename);
				if (entry) {
					entry.set(line_num, br_id);
				}
			});
		}
	}

	/**
	 * Fire events if the simulator hits a breakpoint
	 */
	private fireEventsForBreakPoint(breakpointID: number) {
		var bp = this._breakPoints.get(breakpointID);
		if (bp) {
			this.sendEvent("stopOnBreakpoint");
		} else {

		}

	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}