import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import * as request from 'request';
import * as express from 'express';
import * as http from 'http';
import * as bodyParser from 'body-parser';

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

	private _current_breakpoint_id = -1;
	private _current_local_variables = new Map<string, string>();
	private _current_generator_variables = new Map<string, string>();
	private _current_self_variables = new Map<string, string>();

	// need to pull this from configuration
	private _runtimeIP = "0.0.0.0";
	private _runtimePort = 8888;
	private _debuggerPort = 8889;
	private _connected = false;
	private _app: express.Application;

	private _current_filename: string;
	private _current_line_num: number;

	public current_filename() { return this._current_filename; }
	public current_num() { return this._current_line_num; }
	public getCurrentLocalVariables() { return this._current_local_variables; }
	public getCurrentGeneratorVariables() { return this._current_generator_variables; }
	public getCurrentSelfVariables() { return this._current_self_variables; }


	constructor() {
		super();
	}

	private on_breakpoint(req, res) {
		// we will get a list of values
		var payload: Array<string> = req.body;
		var local: Object = payload["local"];
		var self: Object = payload["self"];
		var generator: Object = payload["generator"];
		var id = Number.parseInt(payload["id"]);
		this._current_filename = payload["filename"];
		this._current_line_num = Number.parseInt(payload["line_num"]);
		this._current_breakpoint_id = id;
		this._current_local_variables = new Map<string, string>(Object.entries(local));
		this._current_self_variables = new Map<string, string>(Object.entries(self));
		this._current_generator_variables = new Map<string, string>(Object.entries(generator));
		this.fireEventsForBreakPoint(id);
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {
		// setup the local server
		this._app = express();
		this._app.use(bodyParser.json());
		this._app.post("/status/breakpoint", (req, res) => {
			this.on_breakpoint(req, res);
		});

		this._app.post("/status/step", (req, res) => {
			this.on_breakpoint(req, res);
		});

		var server = http.createServer(this._app).listen(this._debuggerPort, this._runtimeIP);

		this._app.post("/stop", (_, __) => {
			server.close();
			this.sendEvent('end');
		});

		// connect to the server
		this.connectRuntime(program);
		if (stopOnEntry) {
			this.sendEvent('stopOnEntry');
		}
	}

	public async getGlobalVariables() {
		var promises: Array<Promise<{ name: string, value: any }>> = [];
		promises.push(new Promise((resolve, reject) => {
			request.get(`http://${this._runtimeIP}:${this._runtimePort}/time`, (_, res, body) => {
				if (res.statusCode === 200) {
					resolve({ name: "Time", value: body });
				} else {
					reject("Unknown value");
				}
			});
		}));

		var vars = await Promise.all(promises);
		return vars;
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
					request.post(`http://${this._runtimeIP}:${this._runtimePort}/step_over`);
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
				return vscode.window.showErrorMessage(`Cannot set breakpoint at ${filename}:${line}`);
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
			} else {
				return vscode.window.showErrorMessage(`Failed to get breakpoint at ${filename}:${line}`);
			}
		});
	}

	public stack() {
		// we only have one stack frame
		var frames: Array<any> = [];
		if (this._current_breakpoint_id >= 0) {
			const filename = this.current_filename();
			const line_num = this.current_num();
			frames.push({
				index: 0,
				name: "Simulator Frame",
				file: filename,
				line: line_num
			});
		}
		return {
			frames: frames,
			count: 1
		};
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
		var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint/file/${filename}`;
		request.delete(url);
	}

	private connectRuntime(file: string) {
		// resolve it to make it absolute path
		file = path.resolve(file);
		var payload = { ip: this._runtimeIP, port: this._debuggerPort, database: file };
		var url = `http://${this._runtimeIP}:${this._runtimePort}/connect`;
		var options = {
			method: "post",
			body: payload,
			json: true,
			url: url
		};
		request(options, (_, res, __) => {
			if (res.statusCode !== 200) {
				vscode.window.showErrorMessage("Failed to connect to a running simulator");
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
								vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.file(base_dir) });
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
			this.sendEvent("stopOnBreakpoint");
		}

	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}