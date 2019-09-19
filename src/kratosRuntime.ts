import { Database } from 'sqlite3'
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path'

export interface KratosBreakpoint {
	id: number;
	line: number;
	valid: boolean;
}


export class KratosRuntime extends EventEmitter {

	private _debugFile: string = "";
	private _db: Database | undefined = undefined;
	public get debugFile() {
		return this._debugFile;
	}

	// maps from id to the actual breakpoint
	private _breakPoints = new Map<number, KratosBreakpoint>();
	
	// available breakpoints provided in the database
	private _availableBreakpoints = new Map<string, Map<number, number>>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {

		this.loadSource(program);

		this.verifyBreakpoints();

		if (stopOnEntry) {
			// we step once
			this.step('stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue() {
		this.run(undefined);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(event = 'stopOnStep') {
		this.run(event);
	}


	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(filename: string, line: number) : KratosBreakpoint {
		// get the absolute path
		var filename = path.resolve(filename);
		var bp = <KratosBreakpoint> { valid: false, line, id: this._breakpointId++ };

		if (this._db) {
			var id: number | undefined = undefined;
			this._db.get("SELECT id FROM breakpoint WHERE filename = ? and line_num = ?", [filename, line], function(err, row) {
				id = row.id;
			})
			if (id) {
				bp.valid = true;
				this._breakPoints.set(id, bp);
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
			var id: number | undefined = undefined;
			this._db.get("SELECT id FROM breakpoint WHERE filename = ? and line_num = ?", [filename, line], function(err, row) {
				id = row.id;
			})
			if (id && this._breakPoints.has(id)) {
				var bp = this._breakPoints.get(id);
				this._breakPoints.delete(id);
				return bp;
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
			var list: number[] = []
			this._db.each("SELECT id FROM breakpoint WHERE filename = ?", filename, function(err, row) {
				list.push(row.id);
			})
			list.forEach(id => {
				if (this._breakPoints.has(id)) {
					this._breakPoints.delete(id);
				}
			});
		}
	}

	// private methods

	private loadSource(file: string) {
		if (this._debugFile !== file) {
			this._debugFile = file;
			// load sqlite3
			this._db = new Database(file);
			// run a query to get all available breakpoints
			var bps = new Map<string, Map<number, number>>();
			this._db.each("SELECT * FROM breakpoint", function(err, row) {
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
				if (entry) entry.set(line_num, br_id);
			})
		}
	}

	/**
	 * Fire events if the simulator hits a breakpoint
	 */
	private fireEventsForBreakPoint(breakpointID: number) {
		
		var bp = this._breakPoints.get(breakpointID);
		if (bp) {
			this.sendEvent("stopOnBreakpoint")
			this.sendEvent("breakpointValidated", bp);
		}

	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}