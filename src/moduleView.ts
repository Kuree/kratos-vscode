import * as vscode from 'vscode';
import * as path from 'path';
import * as format from 'string-template';
import * as fs from 'fs';

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

	public static createOrShow(extensionPath: string) {
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

				// And restrict the webview to only loading content from our extension's `media` directory.
				localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
			}
		);

		ModuleViewPanel.currentPanel = new ModuleViewPanel(panel, extensionPath);
	}

	private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
		this._panel = panel;
		this._extensionPath = extensionPath;

		// Set the webview's initial html content
		this._update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'alert':
						vscode.window.showErrorMessage(message.text);
						return;
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