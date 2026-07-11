---
name: web-headers
description: Instructions for how to view the headers on a web http request.
---

Use the bash tool with `curl -I` command when you want to read the headers on an http request:

```bash
# doesn't follow redirects
curl -I http://example.com/pathname 
```

```bash
 # does follow redirects
curl -I -L http://example.com/pathname
```

If you want to see additional curl options, use the bash tool to read curl help:

```bash
curl --help
```
