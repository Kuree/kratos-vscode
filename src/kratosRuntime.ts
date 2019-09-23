import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import * as request from 'request';
import * as express from 'express';

export interface KratosBreakpoint {
	id: number;
	line: number;
	filename: string;
	valid: boolean;
}


export class KratosRuntime extends EventEmitter {

	// maps from id to the actual breakpoint
	private _breakPoints = new Map<number, KratosBreakpoint>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	// need to pull this from configuration
	private _runtimeIP = "0.0.0.0";
	private _runtimePort = 8888;
	private _connected = false;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {
		// setup the local server
		var app = express();
		app.post("/status/breakpoint", (req, res) => {
			// we will get a list of values
			var payload: Array<string> = JSON.parse(req.body);
			var names = payload["value"];
			var id = Number.parseInt(payload["id"]);
			this.fireEventsForBreakPoint(id);

			names.forEach((name: string) => {
				// get values
				request.get(`http://${this._runtimeIP}:${this._runtimePort}/value/${name}`, (_, res, body) => {
					console.log(body);
				});
			});
		});

		app.listen(this._runtimePort, this._runtimeIP, function () { });

		// connect to the server
		this.connectRuntime(program);
		if (stopOnEntry) {
			this.sendEvent('stopOnEntry');
		}

	}

	private run(is_step: Boolean) {
		if (this._connected) {
			if (!is_step) {
				// send the continue commend
				if (this._connected) {
					request.post(`http://${this._runtimeIP}:${this._runtimePort}/continue`);
				}

			} else {
				// send the step command
				if (this._connected) {
					request.post(`http://${this._runtimeIP}:${this._runtimePort}/continue`);
				}
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
	public setBreakPoint(filename: string, line: number): KratosBreakpoint {
		// get the absolute path
		var filename = path.resolve(filename);
		var bp = <KratosBreakpoint>{ valid: false, line, id: this._breakpointId++, filename: filename };

		var payload = { filename: filename, line_num: line };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
		var options = {
			method: "post",
			body: payload,
			json: true,
			url: url
		};
		request(options, (_, res, body) => {
			if (res.statusCode === 200) {
				bp.valid = true;
				this.sendEvent('breakpointValidated', bp);
				var id = Number.parseInt(body);
				this._breakPoints.set(id, bp);
				this.sendBreakpoint(id);
			} else {
				return vscode.window.showInformationMessage("Cannot set breakpoint");
			}
		});

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public async clearBreakPoint(filename: string, line: number) {
		// get the absolute path
		var filename = path.resolve(filename);
		var bp: KratosBreakpoint | undefined = undefined;
		this.sendRemoveBreakpoint(filename, line);

		return bp;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(filename: string): void {
		// find the filename
		var filename = path.resolve(filename);
		this.sendRemoveBreakpoints(filename);
	}

	public getBreakpoints(filename: string, line: number, fn: (id: number) => void) {
		var payload = { filename: filename, line_num: line };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
		var options = {
			method: "get",
			body: payload,
			json: true,
			url: url
		};
		request(options, (_, res, body) => {
			if (res.statusCode === 200) {
				fn(0);
			}
		});
	}

	// private methods

	private sendBreakpoint(break_id: number) {
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint${break_id}`;
		request.post(url);
	}

	private sendRemoveBreakpoint(filename: string, line_num: Number) {
		var payload = { filename: filename, line_num: line_num };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
		var options = {
			method: "delete",
			body: payload,
			json: true,
			url: url
		};
		request(options);
	}

	private sendRemoveBreakpoints(filename: string) {
		var payload = { filename: filename };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint/file`;
		var options = {
			method: "delete",
			body: payload,
			json: true,
			url: url
		};
		request(options);
	}

	private connectRuntime(file: string) {
		// resolve it to make it absolute path
		file = path.resolve(file);
		var payload = { ip: this._runtimeIP, port: this._runtimePort, database: file };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/connect`;
		var options = {
			method: "post",
			body: payload,
			json: true,
			url: url
		};
		request(options, (_, res, __) => {
			if (res.statusCode !== 200) {

			} else {
				this._connected = true;
				// request all the files and open them
				request.get(`http://${this._runtimeIP}:${this._runtimePort}/files`, (_, __, body) => {
					body = JSON.parse(body);
					var opened_dirs = new Set<string>();
					body.forEach((file: string) => {
						// need to open the workspace
						var base_dir = path.dirname(file);
						if (!opened_dirs.has(base_dir)) {
							vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ?
								vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.file(base_dir)});
							opened_dirs.add(base_dir);
						}
						var res = vscode.workspace.openTextDocument(vscode.Uri.file(file));
						if (!res) {
							return vscode.window.showInformationMessage("Unable to open document");
						}
					});
				});
			}
		});
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

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}