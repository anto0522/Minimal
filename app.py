#!/usr/bin/python

import codecs
import datetime
import json
import mimetypes
import os
import re
import platform
import sys
import dateutil.parser
import dateutil.tz

if sys.version_info[0] > 2:
    from urllib.parse import urlparse
    from urllib.parse import parse_qs
    from http.server import HTTPServer
    from http.server import BaseHTTPRequestHandler
else:
    from urlparse import urlparse
    from urlparse import parse_qs
    from BaseHTTPServer import HTTPServer
    from BaseHTTPServer import BaseHTTPRequestHandler

entity_map = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
    "'": "&#39;", "/": "&#x2F;", "`": "&#x60;", "=": "&#x3D;"
}

def escape_html(text):
    return "".join(entity_map.get(c, c) for c in text)

def merge(maps):
    target = {}
    for map in maps:
        target.update(map)
    return target

def mustache(template, view, partials):
    def replace_section(match):
        name = match.group(1)
        content = match.group(2)
        if name in view:
            section = view[name]
            if isinstance(section, list) and len(section) > 0:
                return "".join(mustache(content, merge([ view, item ]), partials) for item in section);
            if isinstance(section, bool) and section:
                return mustache(content, view, partials)
        return ""
    template = re.sub(r"{{#\s*([-_\/\.\w]+)\s*}}\s?([\s\S]*){{\/\1}}\s?", replace_section, template)
    def replace_partial(match):
        name = match.group(1)
        if callable(partials):
            return mustache(partials(name), view, partials)
        return match.group(0)
    template = re.sub(r"{{>\s*([-_/.\w]+)\s*}}", replace_partial, template)
    def replace(match):
        name = match.group(1)
        value = match.group(0)
        if name in view:
            value = view[name]
            if callable(value):
                value = value()
        return value
    template = re.sub(r"{{{\s*([-_/.\w]+)\s*}}}", replace, template)
    def replace_escape(match):
        name = match.group(1)
        value = match.group(0)
        if name in view:
            value = view[name]
            if callable(value):
                value = value()
            value = escape_html(value)
        return value
    template = re.sub(r"{{\s*([-_/.\w]+)\s*}}", replace_escape, template)
    return template

def read_file(path):
    with codecs.open(path, "r", "utf-8") as open_file:
        return open_file.read()

def scheme(request):
    value = request.headers.get("x-forwarded-proto")
    if value and len(value) > 0:
        return value
    value = request.headers.get("x-forwarded-protocol")
    if value and len(value) > 0:
        return value
    return "http"

def redirect(request, status, location):
    request.send_response(status)
    request.send_header("Location", location)
    request.end_headers()

def format_date(date):
    return date.astimezone(dateutil.tz.gettz("UTC")).isoformat("T").split("+")[0] + "Z"

def format_user_date(text):
    date = dateutil.parser.parse(text)
    return date.strftime("%b %d, %Y").replace(" 0", " ")

cache_data = {}

def cache(key, callback):
    if environment == "production":
        if not key in cache_data:
            cache_data[key] = callback()
        return cache_data[key]
    return callback()

path_cache = {}

def init_path_cache(directory):
    if environment == "production":
        for path in os.listdir(directory):
            if not path.startswith("."):
                path = directory + "/" + path
                if os.path.isdir(path):
                    path_cache[path + "/"] = True
                    init_path_cache(path)
                elif os.path.isfile(path):
                    path_cache[path] = True
            if directory == "." and path == ".well-known" and os.path.isdir(path):
                path_cache["./" + path + "/"] = True
                print("certificate")

def exists(path):
    if environment == "production":
        path = "./" + path
        return path in path_cache or (not path.endswith("/") and path + "/" in path_cache)
    return os.path.exists(path)

def isdir(path):
    if environment == "production":
        if path.endswith("/"):
            path = "./" + path
        else:
            path = "./" + path + "/"
        return path in path_cache
    return os.path.isdir(path)

def posts():
    def get_posts():
        files = []
        for filename in sorted(os.listdir("./blog"), reverse=True):
            if os.path.splitext(filename)[1] == ".html":
                files.append(filename)
        return files
    return list(cache("blog:files", get_posts))

tag_regexp = re.compile(r"<(\w+)[^>]*>")
entity_regexp = re.compile(r"(#?[A-Za-z0-9]+;)")
break_regexp = re.compile(r" |<|&")
truncate_map = { "pre": True, "code": True, "img": True, "table": True, "style": True, "script": True, "h2": True, "h3": True }

def truncate(text, length):
    close_tags = {}
    ellipsis = ""
    count = 0
    index = 0
    while count < length and index < len(text):
        if text[index] == "<":
            if index in close_tags:
                index += len(close_tags.pop(index))
            else:
                match = tag_regexp.match(text[index:])
                if match:
                    tag = match.groups()[0].lower()
                    if tag in truncate_map and truncate_map[tag]:
                        break
                    index += match.end()
                    match = re.search("(</" + tag + "\\s*>)", text[index:], re.IGNORECASE)
                    if match:
                        close_tags[index + match.start()] = "</" + tag + ">"
                else:
                    index += 1
                    count += 1
        elif text[index] == "&":
            index += 1
            match = entity_regexp.match(text[index:])
            if match:
                index += match.end()
            count += 1
        else:
            if text[index] == " ":
                index += 1
                count += 1
            skip = len(text) - index
            match = break_regexp.search(text[index:])
            if match:
                skip = match.start()
            if count + skip > length:
                ellipsis = "&hellip;"
            if count + skip - 15 > length:
                skip = length - count
            index += skip
            count += skip
    output = [text[:index]]
    if len(ellipsis) > 0:
        output.append(ellipsis)
    for k in sorted(close_tags.keys()):
        output.append(close_tags[k])
    return "".join(output)

def load_post(path):
    if exists(path) and not isdir(path):
        data = read_file(path)
        entry = {}
        content = []
        metadata = -1
        lines = re.split(r"\r\n?|\n", data)
        while len(lines) > 0:
            line = lines.pop(0)
            if line.startswith("---"):
                metadata += 1
            elif metadata == 0:
                index = line.find(":")
                if index >= 0:
                    name = line[0:index].strip()
                    value = line[index+1:].strip()
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    entry[name] = value
            else:
                content.append(line)
        entry["content"] = "\n".join(content)
        return entry
    return None

def render_blog(files, start):
    view = { "entries": [] }
    length = 10
    index = 0
    while len(files) > 0 and index < start + length:
        filename = files.pop(0)
        entry = load_post("blog/" + filename)
        if entry and (entry["state"] == "post" or environment != "production"):
            if index >= start:
                entry["url"] = "/blog/" + os.path.splitext(filename)[0]
                if "date" in entry:
                    entry["date"] = format_user_date(entry["date"])
                content = entry["content"]
                content = re.sub(r"\s\s", " ", content)
                truncated = truncate(content, 250)
                entry["content"] = truncated
                entry["more"] = truncated != content
                view["entries"].append(entry)
            index += 1
    view["placeholder"] = []
    if len(files) > 0:
        view["placeholder"].append({ "url": "/blog?id=" + str(index) })
    template = read_file("./stream.html")
    return mustache(template, view, None)

def write_string(request, content_type, data):
    encoded = data.encode("utf-8")
    request.send_response(200)
    request.send_header("Content-Type", content_type)
    request.send_header("Content-Length", len(encoded))
    request.end_headers()
    if request.command != "HEAD":
        request.wfile.write(encoded)

def atom_handler(request):
    host = scheme(request) + "://" + request.headers.get("host")
    url = host + "/blog/atom.xml"
    def render_feed():
        count = 10
        feed = {
            "name": configuration["name"],
            "author": configuration["name"],
            "host": host,
            "url": url,
            "entries": [] 
        }
        files = posts()
        while len(files) > 0 and count > 0:
            filename = files.pop(0)
            entry = load_post("blog/" + filename)
            if entry and (entry["state"] == "post" or environment != "production"):
                entry["url"] = host + "/blog/" + os.path.splitext(filename)[0]
                if not "author" in entry or entry["author"] == configuration["name"]:
                    entry["author"] = False
                entry["date"] = format_date(dateutil.parser.parse(entry["date"]))
                entry["updated"] = format_date(dateutil.parser.parse(entry["updated"])) if "updated" in entry else entry["date"];
                if not "updated" in feed or feed["updated"] < entry["updated"]:
                    feed["updated"] = entry["updated"]
                entry["content"] = escape_html(truncate(entry["content"], 10000));
                feed["entries"].append(entry)
                count -= 1
        if not "updated" in feed:
            feed["updated"] = format_date(datetime.datetime.now())
        template = read_file("./atom.xml")
        return mustache(template, feed, None)
    data = cache("atom:" + url, render_feed)
    write_string(request, "application/atom+xml", data)

def post_handler(request):
    filename = urlparse(request.path).path.lstrip("/")
    def render_post():
        entry = load_post(filename + ".html")
        if entry:
            if not "author" in entry:
                entry["author"] = configuration["name"]
            if "date" in entry:
                entry["date"] = format_user_date(entry["date"])
            view = merge([ configuration, entry ])
            template = read_file("./post.html")
            return mustache(template, view, lambda name: read_file(name))
        return ""
    data = cache("post:"+ filename, render_post)
    if len(data) > 0:
        write_string(request, "text/html", data)
        return
    extension = os.path.splitext(filename)
    if extension in mimetypes.types_map:
        default_handler(request)
        return
    root_handler(request)

def blog_handler(request):
    url = urlparse(request.path)
    query = parse_qs(url.query)
    if "id" in query:
        start = int(query["id"][0])
        key = "/blog?id=" + query["id"][0]
        files = posts()
        data = ""
        if start < len(files):
            data = cache("blog:" + key, lambda: render_blog(files, start))
        write_string(request, "text/html", data)
        return
    root_handler(request)

def cert_handler(request):
    filename = urlparse(request.path).path
    if exists(".well-known/") and isdir(".well-known/"):
        if os.path.exists(filename) and os.path.isfile(filename):
            data = read_file(filename)
            return write_string(request, "text/plain; charset=utf-8", data)
            return
    request.send_response(404)
    request.end_headers()

def default_handler(request):
    pathname = urlparse(request.path).path.lower()
    if pathname.endswith("/index.html"):
        redirect(request, 301, "/" + pathname[0:len(pathname) - 11].lstrip("/"))
        return
    filename = pathname
    if pathname.endswith("/"):
        filename = os.path.join(pathname, "index.html")
    filename = filename.lstrip("/")
    if not exists(filename):
        redirect(request, 302, os.path.dirname(pathname))
        return
    if isdir(filename):
        redirect(request, 302, pathname + "/")
        return
    extension = os.path.splitext(filename)[1]
    content_type = mimetypes.types_map[extension]
    if content_type and content_type != "text/html":
        def content():
            with open(os.path.join("./", filename), "rb") as binary:
                return binary.read()
        buffer = cache("default:" + filename, content)
        request.send_response(200)
        request.send_header("Content-Type", content_type)
        request.send_header("Content-Length", len(buffer))
        request.send_header("Cache-Control", "private, max-age=0")
        request.send_header("Expires", -1)
        request.end_headers()
        if request.command != "HEAD":
            request.wfile.write(buffer)
        return
    def content():
        template = read_file(os.path.join("./", filename))
        view = merge([ configuration ])
        view["feed"] = lambda: configuration["feed"] if \
            ("feed" in configuration and len(configuration["feed"]) > 0) else \
            scheme(request) + "://" + request.headers.get("host") + "/blog/atom.xml"
        view["blog"] = lambda: render_blog(posts(), 0)
        return mustache(template, view, lambda name: read_file(name))
    data = cache("default:" + filename, content)
    write_string(request, "text/html", data)

def root_handler(request):
    request.send_response(301)
    request.send_header("Location", "/")
    request.end_headers()

class Router(object):
    def __init__(self, configuration):
        self.routes = []
        if "redirects" in configuration:
            for redirect in configuration["redirects"]:
                self.get(redirect["pattern"], redirect["target"])
    def get(self, pattern, handler):
        self.route(pattern)["handlers"]["GET"] = handler
    def route(self, pattern):
        route = next((route for route in self.routes if route["pattern"] == pattern), None)
        if not route:
            route = {
                "pattern": pattern,
                "regexp": re.compile("^" + pattern.replace("*", "(.*)") + "$"),
                "handlers": {}
            }
            self.routes.append(route)
        return route
    def handle(self, request):
        url = urlparse(request.path)
        for route in self.routes:
            if route["regexp"].match(url.path):
                method = request.command
                if method == "HEAD" and not "HEAD" in route["handlers"]:
                    method = "GET"
                handler = route["handlers"][method]
                if callable(handler): 
                    handler(request)
                else:
                    request.send_response(301)
                    request.send_header("Location", handler)
                    request.end_headers()
                return

class HTTPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        print(self.command + " " + self.path)
        router.handle(self)
    def do_HEAD(self):
        print(self.command + " " + self.path)
        router.handle(self)
    def log_message(self, format, *args):
        return

print("python " + platform.python_version())
with open("./app.json") as configurationFile:
    configuration = json.load(configurationFile)
environment = os.getenv("PYTHON_ENV")
print(environment)
init_path_cache(".")
router = Router(configuration)
router.get("/.git/?*", root_handler)
router.get("/.vscode/?*", root_handler)
router.get("/admin*", root_handler)
router.get("/app.*", root_handler)
router.get("/atom.xml", root_handler)
router.get("/header.html", root_handler)
router.get("/meta.html", root_handler)
router.get("/package.json", root_handler)
router.get("/post.html", root_handler)
router.get("/post.css", root_handler)
router.get("/site.css", root_handler)
router.get("/blog/atom.xml", atom_handler)
router.get("/blog/*", post_handler)
router.get("/blog", blog_handler)
router.get("/.well-known/acme-challenge/*", cert_handler)
router.get("/*", default_handler)
host = "localhost"
port = 8080
print("http://" + host + ":" + str(port))
server = HTTPServer((host, port), HTTPRequestHandler)
server.serve_forever()
