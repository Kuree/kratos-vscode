'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { KratosDebugSession } from './kratosDebug';
import * as Net from 'net';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.kratos-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a debug database file in the workspace folder",
			value: "debug.db"
		});
	}));

	// register a configuration provider for 'kratos' debug type
	const provider = new KratosConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('kratos', provider));

	// The following use of a DebugAdapter factory shows how to run the debug adapter inside the extension host (and not as a separate process).
	const factory = new KratosDebugAdapterDescriptorFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('kratos', factory));
	context.subscriptions.push(factory);
	
}

export function deactivate() {
	// nothing to do
}


class KratosConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): Promise<ProviderResult<DebugConfiguration>> {

		// if launch.json is missing or empty or missing entries
		if (!config.type) {
			config.type = 'kratos';
		}
		if (!config.name) {
			config.name = 'Launch';
		}
		if (!config.request) {
			config.request = 'launch';
		}
		if (!config.runtimeIP) {
			config.runtimeIP = "0.0.0.0";
		}
		if (!config.runtimePort) {
			config.runtimePort = 8888;
		}
		if (!config.stopOnEntry) {
			config.stopOnEntry = true;
		}
		var promise: Array<Promise<string>> = [];
		if (!config.program) {
			// trying to find a db file in the current working directory
			// make a promise
			function findDirPromise(dir: vscode.WorkspaceFolder): Promise<string> {
				return new Promise((resolve, _) => {
					vscode.workspace.fs.readDirectory(dir.uri).then((files) => {
						files.forEach((filename, _) => {
							if (filename[0].split(".").pop() === "db") {
								resolve(path.join(dir.uri.fsPath, filename[0]));
							}
						});
					});
				});
			}
			var folders = vscode.workspace.workspaceFolders;
			if (folders) {
				folders.forEach((dir: vscode.WorkspaceFolder) => {
					promise.push(findDirPromise(dir));
				});
			}
		}
		const result = await Promise.all(promise);
		if (result.length > 0) {
			config.program = result[0];
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

class KratosDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new KratosDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}
