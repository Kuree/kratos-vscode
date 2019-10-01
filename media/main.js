// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
window.onload = () => {
    const vscode = acquireVsCodeApi();

    // const oldState = vscode.getState();
    var nodes = new vis.DataSet([]);
    var edges = new vis.DataSet([]);
    var handle_map = new Map();
    var edges_set = new Set();

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        switch (message.command) {
            case 'hierarchy': {
                const hierarchy = JSON.parse(message.value);
                nodes.clear();
                handle_map.clear();
                edges.clear();
                edges_set.clear();

                hierarchy.forEach(handle_name => {
                    let node_id = 0;
                    if (handle_map.has(handle_map)) {
                        node_id = handle_map.get(handle_name);
                    } else {
                        node_id = handle_map.size;
                        handle_map.set(handle_name, node_id);
                    }
                    const splits = handle_name.split(".");
                    nodes.add({
                        id: node_id, label: splits[splits.length - 1], title: handle_name,
                        value: 30
                    });
                });

                handle_map.forEach((_, handle_name, __) => {
                    get_connection_from(handle_name);
                    get_connection_to(handle_name);
                });
                break;
            }
            case 'connection-to':
            case 'connection-from': {
                const connection = JSON.parse(message.value);
                connection.forEach(conn => {
                    const handle_from = conn.handle_from;
                    const handle_to = conn.handle_to;
                    const var_from = conn.var_from;
                    const var_to = conn.var_to;
                    var label = "";
                    if (var_from === var_to) {
                        label = var_from;
                    } else {
                        label = var_from + " -> " + var_to;
                    }
                    if (handle_map.has(handle_from) && handle_map.has(handle_to)) {
                        const key = `${handle_from}.${var_from} -> ${handle_to}.${var_to}`;
                        if (!edges_set.has(key)) {
                            // add an edge
                            edges.add({
                                from: handle_map.get(handle_from),
                                to: handle_map.get(handle_to),
                                arrows: "to",
                                label: label
                            })
                            edges_set.add(key);
                        }

                    }
                });
            }
        }
    });

    function get_graph(handle_name) {
        vscode.postMessage({ command: "hierarchy", value: handle_name });
    }

    function get_connection_to(handle_name) {
        vscode.postMessage({ command: "connection-to", value: handle_name });
    }

    function get_connection_from(handle_name) {
        vscode.postMessage({ command: "connection-from", value: handle_name });
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