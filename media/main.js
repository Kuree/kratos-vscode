// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
window.onload = () => {
    const vscode = acquireVsCodeApi();

    // const oldState = vscode.getState();
    var nodes = new vis.DataSet([]);
    var edges = new vis.DataSet([]);
    var handle_map = new Map();

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        switch (message.command) {
            case 'hierarchy':
                const hierarchy = JSON.parse(message.value);
                nodes.clear();
                console.log(hierarchy);
                hierarchy.forEach(handle_name => {
                    let node_id = 0;
                    if (handle_map.has(handle_map)) {
                        node_id = handle_map.get(handle_name);
                    } else {
                        node_id = handle_map.size;
                        handle_map.set(node_id, handle_name);
                    }
                    const splits = handle_name.split(".");
                    console.log(splits);
                    nodes.add({
                        id: node_id, label: splits[splits.length - 1], title: handle_name,
                        value: 30
                    });
                });
                break;
        }
    });

    function get_graph(handle_name) {
        vscode.postMessage({ command: "hierarchy", value: handle_name });
    }

    // create a network
    var container = document.getElementById('module-view');
    var data = {
        nodes: nodes,
        edges: edges
    };
    var options = {};
    var network = new vis.Network(container, data, options);

    get_graph("$");

};