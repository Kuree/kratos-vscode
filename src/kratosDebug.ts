import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, ThreadEvent
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { KratosRuntime, KratosBreakpoint } from './kratosRuntime';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/* runtime IP */
	runtimeIP: string;
	runtimePort: number;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	// remote debugging
	srcPath?: string;
	dstPath?: string;
}

export class KratosDebugSession extends LoggingDebugSession {

	private _runtime: KratosRuntime;
	public runtime(): KratosRuntime { return this._runtime; }

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	private _threads: Array<Thread> = [new Thread(0, "Thread 0")];

	/* handle scope request */
	public async getScope(editor: vscode.TextEditor) {
		const filename = editor.document.fileName;
		const selection = editor.selection;
		if (selection.isEmpty) {
			const line_num = selection.active.line + 1;

			await this._runtime.getScope(filename, line_num);
			// create threads accordingly
			// clean up the current threads
			for (let i = 0; i < this._threads.length; i++) {
				this.sendEvent(new ThreadEvent('exited', this._threads[i].id));
			}
			this._threads = [];
			const names = this._runtime.getCurrentGeneratorNames();
			names.forEach((name: string, instance_id: number) => {
				this._threads.push(new Thread(instance_id, name));
			});
			names.forEach((_: string, instance_id: number) => {
				this.sendEvent(new StoppedEvent('data breakpoint', instance_id));
			});
		}
	}

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("kratos-debug.txt");

		// this debugger uses 1-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new KratosRuntime();

		let sendEventThread = (c: any, name: string) => {
			for (let i = 0; i < this._threads.length; i++) {
				this.sendEvent(new c(name, this._threads[i].id));
			}
		};

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			sendEventThread(StoppedEvent, 'entry');
		});
		this._runtime.on('stopOnStep', () => {
			sendEventThread(StoppedEvent, 'step');
		});
		this._runtime.on('stopOnBreakpoint', () => {
			// clean up the current threads
			for (let i = 0; i < this._threads.length; i++) {
				this.sendEvent(new ThreadEvent('exited', this._threads[i].id));
			}
			this._threads = [new Thread(this._runtime.getCurrentBreakpointInstanceId(), "Thread 0")];
			this.sendEvent(new StoppedEvent('breakpoint', this._runtime.getCurrentBreakpointInstanceId()));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this._threads = [new Thread(0, "Thread 0")];
			this.sendEvent(new StoppedEvent('data breakpoint', 0));
		});
		this._runtime.on('stopOnException', () => {
			this._threads = [new Thread(0, "Thread 0")];
			this.sendEvent(new StoppedEvent('exception', 0));
		});
		this._runtime.on('breakpointValidated', (bp: KratosBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.valid, id: bp.id, column: bp.column }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// we support conditional breakpoints
		response.body.supportsConditionalBreakpoints = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		response.body.supportsStepInTargetsRequest = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// support terminate request
		response.body.supportsTerminateRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// set the runtime configuration
		this._runtime.setRuntimeIP(args.runtimeIP);
		this._runtime.setRuntimePort(args.runtimePort);

		// set remote debugging
		this._runtime.setSrcPath(args.srcPath ? args.srcPath : "");
		this._runtime.setDstPath(args.dstPath ? args.dstPath : "");

		// start the program in the runtime
		this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

		const path = <string>args.source.path;
		const breakpoints = args.breakpoints || [];

		// clear all breakpoints for this file
		// It's a command practice to do so (chrome-dev-core does that as well)
		await this._runtime.clearBreakpoints(path);

		let inserted_breakpoints = new Set<string>();

		// set and verify breakpoint locations
		let breakpoints_result = new Array<DebugProtocol.Breakpoint>();

		for (const bp_entry of breakpoints) {
			const bps = await this._runtime.verifyBreakpoint(path, this.convertClientLineToDebugger(bp_entry.line),
				bp_entry.column ? this.convertClientColumnToDebugger(bp_entry.column) : undefined, bp_entry.condition);
			if (bps.length == 0) {
				// invalid breakpoint
				// use -1 for invalid bp id
				const b = <DebugProtocol.Breakpoint>new Breakpoint(false, this.convertDebuggerLineToClient(bp_entry.line),
					bp_entry.column ? this.convertClientColumnToDebugger(bp_entry.column) : undefined);
				breakpoints_result.push(b);
			} else {
				// we only need to create new breakpoint if we haven't created it yet at the same location
				for (const bp of bps) {
					const key = `${path}:${bp.line}:${bp.column}`;
					if (!inserted_breakpoints.has(key)) {
						const b = <DebugProtocol.Breakpoint>new Breakpoint(bp.valid, this.convertDebuggerLineToClient(bp.line),
							bp.column > 0 ? this.convertDebuggerColumnToClient(bp.column) : undefined);
						b.id = bp.id;

						breakpoints_result.push(b);

						// put it into the set
						inserted_breakpoints.add(key);
					}
					this._runtime.sendBreakpoint(bp.id, bp_entry.condition);
				}
			}

		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints_result
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line), (cols) => {
				let bps = new Array<DebugProtocol.BreakpointLocation>();
				cols.forEach(col => {
					bps.push({
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					})
				});
				response.body = {
					breakpoints: bps
				};
				this.sendResponse(response);
			});

		} else {
			response.body = {
				breakpoints: []
			};
			this.sendResponse(response);
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: this._threads
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		// notice that thread ID is the instance id
		const thread_id = args.threadId;
		const stk = this._runtime.stack(thread_id);
		if (stk.count === 0) {
			response.body = {
				stackFrames: [],
				totalFrames: 0
			};
		} else {
			response.body = {
				stackFrames: stk.frames.map((f: { index: number; name: string; file: string; line: number; }) => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
				totalFrames: stk.count
			};
		}
		// different hardware threads are exposed as different stack frames
		// we use the thread ID as frame id, hence passing down the threads to the downstream

		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		// we use frameId as threa id; see the comments above
		const raw_id = args.frameId;
		const ids = KratosRuntime.get_instance_frame_id(raw_id);
		const instance_id = ids[0];
		const frame_id = ids[1];

		response.body = {
			scopes: [
				new Scope("Local", this._variableHandles.create(`local-${instance_id}-${frame_id}`), false),
				new Scope("Generator Variables", this._variableHandles.create(`generator-${instance_id}-${frame_id}`), false),
				new Scope("Simulator Values", this._variableHandles.create(`global--${instance_id}-${frame_id}`), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];

		const raw_id = this._variableHandles.get(args.variablesReference);
		const raw_tokens = raw_id.split('-').filter(n => n);
		let is_generator: boolean = false;
		if (raw_tokens.length !== 3) {
			let has_error = true;
			if (raw_tokens.length === 4) {
				if (raw_tokens[3] === "local") {
					is_generator = false;
					has_error = false;
				} else if (raw_tokens[3] === "generator") {
					is_generator = true;
					has_error = false;
				}
			}
			if (has_error) {
				vscode.window.showErrorMessage("Unable to parse stack variable ID");
				//need to return an empty response
				response.body = {
					variables: variables
				};
				this.sendResponse(response);
				return;
			}

		}
		const id: string = raw_tokens[0];
		const instance_id: number = parseInt(raw_tokens[1]);
		const stack_id = parseInt(raw_tokens[2]);

		// sanity check if there is no variable available
		if (!this._runtime.getCurrentLocalVariables().has(instance_id)) {
			response.body = {
				variables: variables
			};
			this.sendResponse(response);
			return;
		}

		if (id === "local") {
			const instance_vars = this._runtime.getCurrentLocalVariables().get(instance_id);
			if (instance_vars) {
				const vars = instance_vars[stack_id];
				let handles = new Set<string>();
				vars.forEach((value: string, name: string) => {
					// determine whether the name has any dot in it
					// this is top level
					this.processNestedScope(name, handles, instance_id, stack_id, variables, value, false);
				});
			}

		} else if (id === "global") {
			const vars = await this._runtime.getGlobalVariables();
			vars.forEach((entry: { name: string, value: any }) => {
				variables.push({
					name: entry.name,
					type: "integer",
					value: entry.value,
					variablesReference: 0
				});
			});
		} else if (id === "generator") {
			const gen_vars = this._runtime.getCurrentGeneratorVariables().get(instance_id);
			if (gen_vars) {
				const vars = gen_vars[stack_id];
				let handles = new Set<string>();
				vars.forEach((value: string, name: string) => {
					this.processNestedScope(name, handles, instance_id, stack_id, variables, value, true);
				});
			}

		} else {
			// we run a query to figure out any lower level
			const instance_vars = is_generator ? this._runtime.getCurrentGeneratorVariables().get(instance_id) :
				this._runtime.getCurrentLocalVariables().get(instance_id);
			if (instance_vars) {
				const vars = instance_vars[stack_id];
				// we will include the dot here
				const id_name = id + ".";
				let handles = new Set<string>();
				vars.forEach((value: string, name: string) => {
					if (name.length >= id_name.length && name.substr(0, id_name.length) === id_name) {
						let sub_name = name.substr(id_name.length);
						if (sub_name.includes(".")) {
							const name_tokens = sub_name.split(".");
							let next_name = name_tokens[0];
							if (!handles.has(next_name)) {
								let handle_name = id_name + next_name;
								let suffix = is_generator ? "generator" : "local";
								const ref = this._variableHandles.create(`${handle_name}-${instance_id}-${stack_id}-${suffix}`);
								let value = "Object";
								let is_array = false;
								if (id !== "self") {
									if (!isNaN(Number(next_name))) {
										is_array = true;
									}
								} else if (id === "self" && name_tokens.length > 1) {
									const n_next_name = name_tokens[1];
									if (!isNaN(Number(n_next_name))) {
										is_array = true;
									}
								}
								if (is_array) {
									value = "Array";
									if (!isNaN(Number(next_name))) {
										next_name = `[${next_name}]`;
									}
								}
								variables.push({
									name: next_name,
									type: "object",
									value: value,
									variablesReference: ref
								});
								handles.add(next_name);
							}
						} else {
							// that's it
							if (!isNaN(Number(sub_name))) {
								sub_name = `[${sub_name}]`;
							}
							variables.push({
								name: sub_name,
								type: "integer",
								value: value,
								variablesReference: 0
							});
						}
					}
				});
			}
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	private processNestedScope(name: string, handles: Set<string>, instance_id: number, stack_id: number,
		variables: DebugProtocol.Variable[], value: string, isGenerator: Boolean) {
		if (name.includes(".")) {
			// only create handle for the first level
			// we will handle them recursively
			let name_tokens = name.split(".");
			let handle_name = name_tokens[0];
			let next_name = name_tokens[1];
			let suffix = isGenerator ? "generator" : "local";
			if (!handles.has(handle_name)) {
				const ref = this._variableHandles.create(`${handle_name}-${instance_id}-${stack_id}-${suffix}`);
				let value = "Object";
				if (!isNaN(Number(next_name))) {
					value = "Array";
				}
				variables.push({
					name: handle_name,
					type: "object",
					value: value,
					variablesReference: ref
				});
				handles.add(handle_name);
			}
		}
		else {
			variables.push({
				name: name,
				type: "integer",
				value: value,
				variablesReference: 0
			});
		}
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		await this._runtime.stop();
		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'kratos-adapter-data');
	}
}
