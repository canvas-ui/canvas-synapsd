# SynapsD

Naive implementation of a bitmap-centered context-based indexing engine.  
Main functions are:

- Index all user-related events and data into a bitmap-based, dynamic, file-system-like context tree
- Provide relevant data for the context user is working in
- Optimize RAG workloads with contextual information
- (At some point) Integrate into the inference engine

## Architecture

- LMDB, to-be-replaced by pouchdb or rxdb
- Roaring bitmaps
- FlexSearch for full-text search
- LanceDB

### Hashmaps / Inverted indexes

- KV dataset in LMDB
- `checksums/<algo>/<checksum>` | objectID
- `timestamps/<timestamp>` | objectID

### Bitmap indexes

- System
  - `device/uuid/<uuid12>` | bitmap
  - `device/type/<type>` | bitmap
  - `device/os/<os>` | bitmap
  - `action/<action>` | bitmap
- Context
  - `context/<uuid>` | bitmap; **Implicit AND** on all context bitmaps
- Features
  - `data/abstraction/{tab,note,file,email,...}` | bitmap
  - `data/mime/application/json` | bitmap
  - `data/abstraction/email/attachment` | bitmap  
  - `custom/<category>/<tag>` | bitmap; (custom/browser/chrome or custom/tag/work; **implicit OR**, logical NOT support with "!" prefix)  
- Filters
  - `date/YYYYmmdd` | bitmap; logical AND, OR
  - `name/<bitmap-based-fts-test>` | bitmap
- Nested
  - `nested/<abstraction>/<id>` | bitmap
    `data/abstraction/contact/<uuid>` | bitmap
    `data/abstraction/email/from` | `data/abstraction/contact/<uuid>` (or a reference to a nested bitmap)

## References

[0] Tbd
