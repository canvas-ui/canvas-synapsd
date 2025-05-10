# TODO

- ! Create a *proper* collection abstraction, esp. for Bitmaps
- ! Refactor those ***UGLY*** insert/updateDocument methods!!!
- format option
  - full
  - data+meta (data)
  - meta
- Add zod validators to internal schemas
- Besides standard document abstractions, we need to support Canvases and Workspaces, most probably we should remove them from internal or create a proper document abstraction for this type, anyway, todo, lets finally focus on a *usable* mvp damn it!!


## Standalone for each folder with scanning and auto-watch/index?

```
$ROOT_FOLDER
    /.canvas
        /db
        /config
        /data
```
