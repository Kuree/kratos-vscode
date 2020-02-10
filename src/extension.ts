'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken, commands} from 'vscode';
import { KratosDebugSession } from './kratosDebug';
import * as Net from 'net';
import { ModuleViewPanel} from './moduleView';
import {ContextKey} from './utils';


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
	
	// this is for module viewer
	context.subscriptions.push(
		vscode.commands.registerCommand('kratosView.start', () => {
			ModuleViewPanel.createOrShow(context.extensionPath, factory.session);
		})
	);

	// this is for scope viewing
	context.subscriptions.push(
		commands.registerTextEditorCommand('kratos.scope', editor => {
			factory.session.getScope(editor);
		})
	);

	context.subscriptions.push(
		commands.registerTextEditorCommand('kratos.stopOnSync', () => {
			factory.session.runtime().stopOnSync();
		})
	);
	// disable the context menu by default
	// the implementation is copied from
	// microsoft/vscode-extension-samples/vim-sample
	let c = new ContextKey("kratos.scopeAllowed");
	c.set(false);

	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(ModuleViewPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				console.log(`Got state: ${state}`);
				ModuleViewPanel.revive(webviewPanel, context.extensionPath);
			}
		});
	}
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
		if (!config.dstPath) {
			config.dstPath = "";
		}
		if (!config.srcPath) {
			config.srcPath = "";
		}

		if (!config.program) {
			vscode.window.showErrorMessage("Program name cannot be empty!");
			throw vscode.FileSystemError.FileNotFound("${debug.db}");
		}

		return config;
	}
}

class KratosDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;
	public session: KratosDebugSession;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new KratosDebugSession();
				this.session = session;
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
