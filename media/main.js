// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
window.onload = () => {
    const vscode = acquireVsCodeApi();

    // styling
    const fontColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground');
    const barBackgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-statusBar-background');
    const barDebugBackgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-statusBar-debuggingBackground');

    // const oldState = vscode.getState();
    var nodes = new vis.DataSet([]);
    var edges = new vis.DataSet([]);
    var handle_map = new Map();
    var id_to_handle = new Map();
    var edges_set = new Set();
    var edges_map = new Map();
    var handle_edge = new Map();
    var handle_label = new Map();
    var edge_value = new Map();

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        switch (message.command) {
            case 'hierarchy': {
                const hierarchy = JSON.parse(message.value);
                nodes.clear();
                handle_map.clear();
                id_to_handle.clear();
                edges.clear();
                edges_set.clear();

                hierarchy.forEach(handle_name => {
                    console.log(handle_name);
                    let node_id = 0;
                    if (handle_map.has(handle_name)) {
                        return;
                    } else {
                        node_id = handle_map.size;
                        handle_map.set(handle_name, node_id);
                        id_to_handle.set(node_id, handle_name);
                    }
                    const splits = handle_name.split(".");
                    nodes.add({
                        id: node_id, label: splits[splits.length - 1], title: handle_name,
                        shape: 'box'
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
                var new_edges = [];
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
                            const edge = {
                                from: handle_map.get(handle_from),
                                to: handle_map.get(handle_to),
                                arrows: "to",
                                label: label,
                                var: `${handle_from}.${var_from}`,
                                id: edges_set.length,
                                font: {
                                    color: fontColor, strokeWidth: 0
                                },
                                color: barBackgroundColor
                            };
                            edges.add(edge);
                            new_edges.push(edge);
                            edges_set.add(key);
                            edges_map.set(edge.var, edge)
                        }

                    }
                });
                // we need to send monitor to connected edges
                new_edges.forEach((edge, _, __) => {
                    // we only need the from one since it's wired together
                    const handle = edge.var;
                    handle_label.set(handle, edge.label);
                })
                break;
            }
            case 'value': {
                // monitored value
                const value = message.value;
                var handle = value.handle;
                const v = value.value;
                // find the edge handle
                // FIXME: use the top name from the webview
                if (handle.indexOf("TOP.") === 0) {
                    handle = handle.replace("TOP.", "");
                }
                const edge = edges_map.get(handle);
                if (edge) {
                    var label = handle_label.get(handle);
                    label += "\n" + v;
                    if (edge.label === label) {
                        edge.color = barBackgroundColor;
                    } else {
                        edge.label = label;
                        edge.color = barDebugBackgroundColor;
                    }
                    edges.update(edge);
                }
                break;
            }
            case 'time': {
                const label = document.getElementById("time-display");
                label.innerHTML = ` Time: ${message.value}`
                break;
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

    // let runtime know that we want to pause on clock edge
    vscode.postMessage({command: "pause-on-clock", value: true});
    var btn_pause_clock = document.getElementById("pause-on-clock");
    var is_pause_clock = true;
    btn_pause_clock.onclick = () => {
        is_pause_clock = !is_pause_clock;
        if (is_pause_clock) {
            btn_pause_clock.innerText = "Break on Clock Edge: On ";
        } else {
            btn_pause_clock.innerText = "Break on Clock Edge: Off";
        }
        vscode.postMessage({command: "pause-on-clock", value: is_pause_clock});
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