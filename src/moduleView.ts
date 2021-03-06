import * as vscode from 'vscode';
import * as path from 'path';
import * as format from 'string-template';
import * as fs from 'fs';
import {KratosDebugSession} from './kratosDebug';
import {KratosRuntime} from './kratosRuntime';

/**
 * This class controls the webview panel that will be used for monitoring
 */
export class ModuleViewPanel {
	// the code is based on https://github.com/microsoft/vscode-extension-samples/blob/master/webview-sample/
	public static currentPanel: ModuleViewPanel | undefined;

	public static readonly viewType = "kratosModuleView";
	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];
	private static runtime: KratosRuntime;

	public static createOrShow(extensionPath: string, session: KratosDebugSession) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it.
		if (ModuleViewPanel.currentPanel) {
			ModuleViewPanel.currentPanel._panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			ModuleViewPanel.viewType,
			'Kratos Module Viewer',
			column || vscode.ViewColumn.One,
			{
				// Enable javascript in the webview
				enableScripts: true,
				retainContextWhenHidden: true,
				// And restrict the webview to only loading content from our extension's `media` directory.
				localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
			}
		);

		ModuleViewPanel.runtime = session.runtime();
		ModuleViewPanel.currentPanel = new ModuleViewPanel(panel, extensionPath);
	}

	private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
		this._panel = panel;
		this._extensionPath = extensionPath;

		// Set the webview's initial html content
		this._update();

		const onValueChange = (handle: string, value: string) => {
			// send info to the webview
			this._panel.webview.postMessage({command: "value", value: {handle: handle, value: value}});
		};

		const updateValue = (value: any) => {
			// send values over
			var values: Map<string, string>;
			if (!(value instanceof Map)) {
				values = new Map<string, string>(Object.entries(value));
			} else {
				values = value;
			}
			values.forEach((v, name) => {
				this._panel.webview.postMessage({command: "value", "value": {handle: name, value: v}});
			});
		};

		const onClockEdge = (value: any) => {
			// send time info to the webview as well
			const time = value.time;
			this._panel.webview.postMessage({command: "clock-paused", value: value});
			this._panel.webview.postMessage({command: "time", value: time});

			updateValue(value.value);
		};

		const onTimeChange = (time: any) => {
			this._panel.webview.postMessage({command: "time", value: time});
		};

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// set the function callback
		ModuleViewPanel.runtime.setOnValueChange(onValueChange);
		ModuleViewPanel.runtime.setOnClockEdge(onClockEdge);
		ModuleViewPanel.runtime.setOnTimeChange(onTimeChange);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'hierarchy': {
						const value = message.value;
						const hierarchy: any = await ModuleViewPanel.runtime.getHierarchy(value);
						// send it back
						if (typeof hierarchy.value !== 'undefined') {
							this._panel.webview.postMessage({command: "hierarchy", value: {hierarchy: hierarchy.name, value: hierarchy.value}});
						} else {
							this._panel.webview.postMessage({command: "hierarchy", value: {hierarchy: hierarchy.name}});
						}
						return;
					}
					case 'connection-to': {
						const handle = message.value;
						const connection = await ModuleViewPanel.runtime.getConnectionTo(handle);
						// send it back
						this._panel.webview.postMessage({command: "connection-to", value: connection});
						return;
					}
					case 'connection-from': {
						const handle = message.value;
						const connection = await ModuleViewPanel.runtime.getConnectionFrom(handle);
						// send it back
						this._panel.webview.postMessage({command: "connection-from", value: connection});
						return;
					}
					case 'add-monitor': {
						const handle = message.value;
						// tell the runtime to monitor this handle value
						ModuleViewPanel.runtime.monitorHandle(handle);
						return;
					}
					case 'remove-monitor': {
						const handle = message.value;
						// remove the monitor handle
						ModuleViewPanel.runtime.deleteMonitorHandle(handle);
						return;
					}
					case 'pause-on-clock': {
						const value = message.value;
						ModuleViewPanel.runtime.sendPauseOnClock(value);
						return;
					}
					case 'continue': {
						ModuleViewPanel.runtime.continue();
						return;
					}
				}
			},
			null,
			this._disposables
		);
	}

	public dispose() {
		ModuleViewPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
		// clear the monitors
		// ModuleViewPanel.runtime.clearAllMonitors();
		// no pause on edge
		ModuleViewPanel.runtime.sendPauseOnClock(false);
	}

	public static revive(panel: vscode.WebviewPanel, extensionPath: string) {
		ModuleViewPanel.currentPanel = new ModuleViewPanel(panel, extensionPath);
	}

	private async _update() {
		const webview = this._panel.webview;
		this._panel.title = "Kratos Module Viewer";
		webview.html = await this._getHtmlForWebview(webview);
	}

	private async _getHtmlForWebview(webview: vscode.Webview) {
		// Local path to main script run in the webview
		const mediaDir = path.join(this._extensionPath, 'media');
		const scriptPathOnDisk = vscode.Uri.file(path.join(mediaDir, 'main.js'));
		const htmlOnDisk = vscode.Uri.file(path.join(mediaDir, 'main.html'));

		const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
		const nonce = getNonce();

		const content: string = fs.readFileSync(htmlOnDisk.fsPath, 'utf-8');
		const html = format(content, {nonce: nonce, scriptUri: scriptUri});
		
		return html;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
