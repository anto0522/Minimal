#!/usr/bin/env node

"use strict";

var fs = require("fs");
var http = require("http");
var path = require("path");
var url = require("url");

var entityMap = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#x2F;", "`": "&#x60;", "=": "&#x3D;"
};

function escapeHtml(text) {
    return text.replace(/[&<>"'`=\/]/g, function (char) {
        return entityMap[char];
    });
}

function merge() {
    var target = {};
    for (var i = 0; i < arguments.length; i++) {
        target = Object.assign(target, arguments[i]);
    }
    return target;
}
function mustache(template, view, partials) {
    template = template.replace(/{{#\s*([-_\/\.\w]+)\s*}}\s?([\s\S]*){{\/\1}}\s?/gm, function (match, name, content) {
        if (name in view) {
            var section = view[name];
            if (Array.isArray(section) && section.length > 0) {
                return section.map(item => mustache(content, merge(view, item), partials)).join("");
            }
            if (typeof(section) === "boolean" && section) {
                return mustache(content, view, partials);
            }
        }
        return "";
    });
    template = template.replace(/{{>\s*([-_\/\.\w]+)\s*}}/gm, function (match, name) {
        return mustache(typeof partials === "function" ? partials(name) : partials[name], view, partials);
    });
    template = template.replace(/{{{\s*([-_\/\.\w]+)\s*}}}/gm, function (match, name) {
        var value = view[name];
        return typeof value === "function" ? value() : value;
    });
    template = template.replace(/{{\s*([-_\/\.\w]+)\s*}}/gm, function (match, name) {
        var value = view[name];
        return escapeHtml(typeof value === "function" ? value() : value);
    });
    return template;
}

function scheme(request) {
    if (request.headers["x-forwarded-proto"]) {
        return request.headers["x-forwarded-proto"];
    }
    if (request.headers["x-forwarded-protocol"]) {
        return request.headers["x-forwarded-protocol"];
    }
    return "http";
}

function redirect(response, status, location) {
    response.writeHead(status, { "Location": location });
    response.end();
}

function formatDate(date) {
    return date.toISOString().replace(/\.[0-9]*Z/, "Z");
}

function formatUserDate(text) {
    var date = new Date(text.split(/ \+| \-/)[0] + "Z");
    var months = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ];
    return months[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear();
}

var cacheData = {};

function cache(key, callback) {
    if (environment === "production") {
        if (!(key in cacheData)) {
            cacheData[key] = callback();
        }
        return cacheData[key];
    }
    return callback();
}

var pathCache = {};

function initPathCache(directory) {
    if (environment === "production") {
        fs.readdirSync(directory).forEach(function(file) {
            if (!file.startsWith(".")) {
                file = directory + "/" + file;
                if (fs.statSync(file).isDirectory()) {
                    pathCache[file + "/"] = true;
                    initPathCache(file);
                }
                else {
                    pathCache[file] = true;
                }
            }
            if (directory === "." && file === ".well-known" && fs.statSync(file).isDirectory()) {
                pathCache["./" + file + "/"] = true;
                console.log("certificate");
            }
        });
    }
}

function exists(path) {
    if (environment === "production") {
        path = "./" + path;
        return pathCache[path] || (!path.endsWith("/") && pathCache[path + "/"]);
    }
    return fs.existsSync(path);
}

function isDirectory(path) {
    if (environment === "production") {
        path = "./" + (path.endsWith("/") ? path : path + "/");
        return pathCache[path];
    }
    return fs.statSync(path).isDirectory();
}

var truncateMap = { "pre": true, "code": true, "img": true, "table": true, "style": true, "script": true, "h2": true, "h3": true };

function truncate(text, length) {
    var closeTags = {};
    var ellipsis = "";
    var count = 0;
    var index = 0;
    while (count < length && index < text.length) {
        if (text[index] == '<') {
            if (index in closeTags) {
                var closeTagLength = closeTags[index].length;
                delete closeTags[index];
                index += closeTagLength;
            } 
            else {
                var match = text.substring(index).match("<(\\w+)[^>]*>");
                if (match) {
                    var tag = match[1].toLowerCase();
                    if (tag in truncateMap) {
                        break;
                    }
                    index += match[0].length;
                    var closeTagRegExp = new RegExp("(</" + tag + "\\s*>)", "i");
                    var end = text.substring(index).search(closeTagRegExp);
                    if (end != -1) {
                        closeTags[index + end] = "</" + tag + ">";
                    }
                }
                else {
                    index++;
                    count++;
                }
            }
        }
        else if (text[index] == "&") {
            index++;
            var entity = text.substring(index).match("(#?[A-Za-z0-9]+;)");
            if (entity) {
                index += entity[0].length;
            }
            count++;
        }
        else {
            if (text[index] == " ") {
                index++;
                count++;
            }
            var skip = text.substring(index).search(" |<|&");
            if (skip == -1) {
                skip = text.length - index;
            }
            if (count + skip > length) {
                ellipsis = "&hellip;";
            }
            if (count + skip - 15 > length) {
                skip = length - count;
            }
            index += skip;
            count += skip;
        }
    }
    var output = [ text.substring(0, index) ];
    if (ellipsis !== "") {
        output.push(ellipsis);
    }
    var keys = [];
    for (var key in closeTags) {
        keys.push(Number(key));
    }
    keys.sort().forEach(function (key) {
        output.push(closeTags[key]);
    });
    return output.join("");
}

function posts() {
    return cache("blog:files", function() {
        return fs.readdirSync("./blog/").filter(file => path.extname(file) === ".html").sort().reverse();
    }).slice(0);
}

function loadPost(file) {
    if (exists(file) && !isDirectory(file)) {
        var data = fs.readFileSync(file, "utf-8");
        if (data) {
            var entry = {};
            var content = [];
            var metadata = -1;
            var lines = data.split(/\r\n?|\n/g);
            while (lines.length > 0) {
                var line = lines.shift();
                if (line.startsWith("---")) {
                    metadata++;
                }
                else if (metadata === 0) {
                    var index = line.indexOf(":");
                    if (index >= 0) {
                        var name = line.slice(0, index).trim();
                        var value = line.slice(index + 1).trim();
                        if (value.startsWith('"') && value.endsWith('"')) {
                            value = value.slice(1, -1);
                        }
                        entry[name] = value;
                    }
                }
                else {
                    content.push(line);
                }
            }
            entry["content"] = content.join("\n");
            return entry;
        }
    }
    return null;
}

function renderBlog(files, start) {
    var view = { "entries": [] }
    var length = 10;
    var index = 0;
    while (files.length > 0 && index < (start + length)) {
        var file = files.shift();
        var entry = loadPost("blog/" + file);
        if (entry && (entry["state"] === "post" || environment !== "production")) {
            if (index >= start) {
                entry["url"] = "/blog/" + path.basename(file, ".html");
                entry["date"] = formatUserDate(entry["date"]);
                var content = entry["content"];
                content = content.replace(/\s\s/g, " ");
                var truncated = truncate(content, 250);
                entry["content"] = truncated;
                entry["more"] = truncated != content;
                view["entries"].push(entry);
            }
            index++;
        }
    }
    view["placeholder"] = [];
    if (files.length > 0) {
        view["placeholder"].push({ "url": "/blog?id=" + index.toString() });
    }
    var template = fs.readFileSync("stream.html", "utf-8");
    return mustache(template, view, null);
}

function writeString(request, response, contentType, data) {
    response.writeHead(200, { 
        "Content-Type": contentType, 
        "Content-Length": Buffer.byteLength(data)
    });
    if (request.method !== "HEAD") {
        response.write(data);
    }
    response.end();
}

function rootHandler(request, response) {
    redirect(response, 302, "/");
}

function atomHandler(request, response) {
    var host = scheme(request) + "://" + request.headers.host;
    var url = host + "/blog/atom.xml";
    var data = cache("atom:" + url, function () {
        var count = 10;
        var feed = {
            "name": configuration["name"],
            "author": configuration["name"],
            "host": host,
            "url": url,
            "entries": [] 
        };
        var files = posts();
        while (files.length > 0 && count > 0) {
            var file = files.shift();
            var entry = loadPost("blog/" + file);
            if (entry && (entry["state"] === "post" || environment !== "production")) {
                entry["url"] = host + "/blog/" + path.basename(file, ".html"); 
                if (!entry["author"] || entry["author"] === configuration["name"]) {
                    entry["author"] = false;
                }
                entry["date"] = formatDate(new Date(entry["date"]));
                entry["updated"] = entry["updated"] ? formatDate(new Date(entry["updated"])) : entry["date"];
                if (!feed["updated"] || feed["updated"] < entry["updated"]) {
                    feed["updated"] = entry["updated"];
                }
                entry["content"] = escapeHtml(truncate(entry["content"], 10000));
                feed["entries"].push(entry);
                count--;
            }
        }
        if (!feed["updated"]) {
            feed["updated"] = formatDate(new Date());
        }
        var template = fs.readFileSync("atom.xml", "utf-8");
        return mustache(template, feed, null);
    });
    writeString(request, response, "application/atom+xml", data);
}

var mimeTypeMap = {
    ".js":   "text/javascript",
    ".css":  "text/css",
    ".png":  "image/png",
    ".gif":  "image/gif",
    ".jpg":  "image/jpeg",
    ".ico":  "image/x-icon",
    ".zip":  "application/zip",
    ".json": "application/json"
};

function postHandler(request, response) {
    var pathname = url.parse(request.url, true).pathname;
    var file = pathname.replace(/^\/?/, "");
    var data = cache("post:" + file, function() {
        var entry = loadPost(file + ".html");
        if (entry) {
            entry["date"] = formatUserDate(entry["date"]);
            entry["author"] = entry["author"] || configuration["name"];
            var view = merge(configuration, entry);
            var template = fs.readFileSync("post.html", "utf-8");
            return mustache(template, view, function(name) {
                return fs.readFileSync(name, "utf-8");
            });
        }
        return null;
    });
    if (data) {
        writeString(request, response, "text/html", data);
        return;
    }
    var extension = path.extname(file);
    var contentType = mimeTypeMap[extension] ;
    if (contentType) {
        defaultHandler(request, response);
        return;
    }
    rootHandler(request, response);
}

function blogHandler(request, response) {
    var query = url.parse(request.url, true).query;
    if (query.id) {
        var id = Number(query.id);
        var key = "/blog?id=" + query.id;
        var files = posts();
        var data = "";
        if (id < files.length) {
            data = cache("blog:" + key, function() {
                return renderBlog(files, id);
            });
        }
        writeString(request, response, "text/html", data);
        return;
    }
    rootHandler(request, response);
}

function certHandler(request, response) {
    var file = url.parse(request.url, true).pathname.replace(/^\/?/, "");
    if (exists(".well-known/") && isDirectory(".well-known/")) {
        if (fs.existsSync(file) && fs.statSync(file).isFile) {
            var data = fs.readFileSync(file, "utf-8");
            writeString(request, respnse, "text/plain; charset=utf-8", data);
            return;
        }
    }
    response.writeHead(404);
    response.end();
}

function defaultHandler(request, response) {
    var pathname = url.parse(request.url, true).pathname.toLowerCase();
    if (pathname.endsWith("/index.html"))
    {
        redirect(response, 301, "/" + pathname.substring(0, pathname.length - 11).replace(/^\/?/, ""));
        return;
    }
    var file = (pathname.endsWith("/") ? pathname + "index.html" : pathname).replace(/^\/?/, "");
    if (!exists(file)) {
        redirect(response, 302, path.dirname(pathname));
        return;
    }
    if (isDirectory(file)) {
        redirect(response, 302, pathname + "/");
        return;
    }
    var extension = path.extname(file);
    var contentType = mimeTypeMap[extension];
    if (contentType) {
        var buffer = cache("default:" + file, function() {
            try {
                var size = fs.statSync(file).size;
                var buffer = new Buffer(size);
                var descriptor = fs.openSync(file, "r");
                fs.readSync(descriptor, buffer, 0, buffer.length, 0);
                fs.closeSync(descriptor);
                return buffer;
            }
            catch (error) {
                console.log(error);
            }
            return new Buffer(0);
        });
        response.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buffer.length,
            "Cache-Control": "private, max-age=0",
            "Expires": -1 
        });
        if (request.method !== "HEAD") {
            response.write(buffer, "binary");
        }
        response.end();
        return;
    }
    var data = cache("default:" + file, function() {
        var template = fs.readFileSync(file, "utf-8");
        var view = merge(configuration);
        view["feed"] = function() {
            if (configuration["feed"] && configuration["feed"].length > 0) {
                return configuration["feed"];
            }
            return scheme(request) + "://" + request.headers.host + "/blog/atom.xml";
        };
        view["blog"] = function() {
            return renderBlog(posts(), 0);
        };
        return mustache(template, view, function(name) {
            return fs.readFileSync(name, "utf-8");
        });
    });
    writeString(request, response, "text/html", data);
}

function Router(configuration) {
    this.routes = [];
    if (configuration["redirects"]) {
        for (var i = 0; i < configuration["redirects"].length; i++) {
            var redirect = configuration["redirects"][i]
            var target = redirect["target"];
            this.get(redirect["pattern"], function (request, response) {
                response.writeHead(301, { "Location": target });
                response.end();
            });
        }
    }
}

Router.prototype.route = function (pattern) {
    var route = this.routes.find(route => route.path === path);
    if (!route) {
        route = {
            pattern: pattern,
            regexp: new RegExp("^" + pattern.replace("*", "(.*)") + "$", "i"),
            handlers: {}
        };
        this.routes.push(route);
    }
    return route;
};

Router.prototype.handle = function (request, response) {
    var pathname = url.parse(request.url, true).pathname;
    for (var i = 0; i < this.routes.length; i++) {
        var route = this.routes[i];
        if (pathname.match(route.regexp) !== null) {
            var method = request.method.toUpperCase();
            if (method === "HEAD" && !route.handlers["HEAD"]) {
                method = "GET";
            }
            var handler = route.handlers[method];
            if (handler) {
                try {
                    handler(request, response);
                }
                catch (error) {
                    console.log(error);
                }
                return;
            }
        }
    }
};

Router.prototype.get = function (pattern, handler) {
    this.route(pattern).handlers["GET"] = handler;
};

console.log("node " + process.version);
var configuration = JSON.parse(fs.readFileSync("./app.json", "utf-8"));
var environment = process.env.NODE_ENV;
console.log(environment);
initPathCache(".");
var router = new Router(configuration);
router.get("/.git/?*", rootHandler)
router.get("/.vscode/?*", rootHandler);
router.get("/admin*", rootHandler);
router.get("/app.*", rootHandler);
router.get("/atom.xml", rootHandler);
router.get("/header.html", rootHandler);
router.get("/meta.html", rootHandler);
router.get("/package.json", rootHandler);
router.get("/post.html", rootHandler);
router.get("/post.css", rootHandler);
router.get("/site.css", rootHandler);
router.get("/blog/atom.xml", atomHandler);
router.get("/blog/*", postHandler);
router.get("/blog", blogHandler);
router.get("/.well-known/acme-challenge/*", certHandler);
router.get("/*", defaultHandler);
var server = http.createServer(function (request, response) {
    console.log(request.method + " " + request.url);
    router.handle(request, response);
});
var port = process.env.PORT || 8080;
server.listen(port, function() {
    console.log("http://localhost:" + port);
});
