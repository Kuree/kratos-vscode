import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { KratosRuntime, KratosBreakpoint } from './kratosRuntime';
const { Subject } = require('await-notify');

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/* runtime IP */
	runtimeIP :string;
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

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _runtime: KratosRuntime;
	public runtime(): KratosRuntime { return this._runtime; }

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("kratos-debug.txt");

		// this debugger uses 1-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new KratosRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', KratosDebugSession.THREAD_ID));
		});
		// TODO
		// implement this
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', KratosDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', KratosDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnPause', () => {
			this.sendEvent(new StoppedEvent('pause', KratosDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', KratosDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', KratosDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: KratosBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.valid, id: bp.id }));
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
		response.body.completionTriggerCharacters = [ ".", "[" ];

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
		this._runtime.setSrcPath(args.srcPath? args.srcPath: "");
		this._runtime.setDstPath(args.dstPath? args.dstPath: "");

		// start the program in the runtime
		this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

		const path = <string>args.source.path;
		const breakpoints = args.breakpoints || [];

		// clear all breakpoints for this file
		await this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = breakpoints.map(l => {
			const kratos_bp = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l.line), l.condition);
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(kratos_bp.valid, this.convertDebuggerLineToClient(kratos_bp.line));
			bp.id= kratos_bp.id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line), (col) => {
				response.body = {
					breakpoints: [{
							line: args.line,
							column: this.convertDebuggerColumnToClient(col)
						}]
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

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(KratosDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {

		const stk = this._runtime.stack();

		response.body = {
			stackFrames: stk.frames.map((f: { index: number; name: string; file: string; line: number; }) => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Local", this._variableHandles.create("local"), false),
				new Scope("Generator Variables", this._variableHandles.create("generator"), false),
				new Scope("Simulator Values", this._variableHandles.create("global"), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];

		const id = this._variableHandles.get(args.variablesReference);

		// 0 is local
		if (id === "local") {
			const vars = this._runtime.getCurrentLocalVariables();
			let handles = new Set<string>();
			vars.forEach((value: string, name: string) => {
				// determine whether the name has any dot in it
				// this is top level
				if (name.includes(".")) {
					// only create handle for the first level
					// we will handle them recursively
					const handle_name = name.split(".")[0];
					if (!handles.has(handle_name)) {
						const ref = this._variableHandles.create(handle_name);
						variables.push({
							name: handle_name,
							type: "object",
							value: "Object",
							variablesReference: ref
						});
						handles.add(handle_name);
					}
				} else {
					variables.push({
						name: name,
						type: "integer",
						value: value,
						variablesReference: 0
					});
				}
			});
		} else if (id === "global") {
			const vars = await this._runtime.getGlobalVariables();
			vars.forEach((entry: {name: string, value: any}) => {
				variables.push({
					name: entry.name,
					type: "integer",
					value: entry.value,
					variablesReference: 0
				});
			});
		} else if (id === "generator") {
			const vars = this._runtime.getCurrentGeneratorVariables();
			vars.forEach((value: string, name: string) => {
				variables.push({
					name: name,
					type: "integer",
					value: value,
					variablesReference: 0
				});
			});
		} else {
			// we run a query to figure out any lower level
			const vars = this._runtime.getCurrentLocalVariables();
			// we will include the dot here
			const id_name = id + ".";
			let handles = new Set<string>();
			vars.forEach((value: string, name: string) => {
				if (name.length >= id_name.length && name.substr(0, id_name.length) === id_name) {
					const sub_name = name.substr(id_name.length);
					if (sub_name.includes(".")) {
						const next_name = sub_name.split(".")[0];
						if (!handles.has(next_name)) {
							const ref = this._variableHandles.create(id_name + next_name);
							variables.push({
								name: next_name,
								type: "object",
								value: "Object",
								variablesReference: ref
							});
							handles.add(next_name);
						}
					} else {
						// that's it
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

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected evaluateRequest( response:DebugProtocol.EvaluateResponse, args:DebugProtocol.EvaluateArguments ): void {
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
