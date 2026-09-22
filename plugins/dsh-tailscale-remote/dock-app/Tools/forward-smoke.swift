// Headless harness for PortForward.swift (compiled together with it by
// scripts/forward-smoke.mjs): forward the given remote ports through the given
// DSH base URL and report the outcome on stdout, one line per port —
//   LOCAL <remotePort> <localPort>          the listener is up
//   REFUSED <remotePort> <code> <message>   the remote said no
// — then keep the listeners alive until stdin closes. No WKWebView involved;
// cookies come from the (empty) default data store, so admission is whatever
// the endpoint grants a bare loopback caller.

import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let arguments = CommandLine.arguments
guard arguments.count >= 3, let base = URL(string: arguments[1]) else {
    FileHandle.standardError.write("usage: forward-smoke <dsh base url> <remote port> [<remote port>…]\n".data(using: .utf8)!)
    exit(2)
}
let ports = arguments.dropFirst(2).compactMap { Int($0) }
let forwarder = PortForwarder(endpointBase: { base }, log: { line in
    FileHandle.standardError.write("\(line)\n".data(using: .utf8)!)
})
var outstanding = ports.count
for port in ports {
    forwarder.ensure(remotePort: port) { result in
        switch result {
        case .success(let listener): print("LOCAL \(port) \(listener.localPort)")
        case .failure(let error): print("REFUSED \(port) \(error.refusalCode ?? "transport") \(error)")
        }
        outstanding -= 1
        if outstanding == 0 { print("READY") }
    }
}
// Exit when the driver closes stdin.
DispatchQueue.global().async {
    while readLine() != nil {}
    forwarder.closeAll()
    exit(0)
}
RunLoop.main.run()
