# RAG Architecture Review & Recommendations

! Claude-4-opus based on [TODO.md](./TODO.md)

## Overview
This document captures the architectural review of the proposed RAG (Retrieval-Augmented Generation) system for SynapsD, focusing on the innovative bitmap pre-filtering approach combined with vector search.

## Current Context
- SynapsD already implements a bitmap-powered filesystem-like tree structure
- Context switching (e.g., `/work/acmeorg/devops/task-1234`) already retrieves related files, browser tabs, notes, todos, emails
- Need to focus on MVP delivery before implementing advanced RAG features

## What's Working Well

### 1. Bitmap Pre-filtering for Vector Search
- **Brilliant for scale**: Sub-millisecond filtering before expensive vector operations
- **Memory efficient**: Roaring bitmaps are perfect for sparse document sets
- **Fast boolean ops**: Complex query logic becomes trivial with AND/OR/XOR operations

### 2. Context Tree Integration
- Already proven with the filesystem-like navigation
- Natural fit for hierarchical concept filtering
- Users already understand the mental model

## Architecture Refinements

### Phase 1: MVP Foundation (IMMEDIATE PRIORITY)
Focus on shipping working browser extension with new API before any RAG implementation.

### Phase 2: Basic RAG Implementation

#### 2.1 Hybrid Chunking Approach
```javascript
// Start simple with traditional chunking + concept enrichment
class DocumentProcessor {
    async process(document) {
        // Traditional chunking as baseline
        const chunks = await this.chunkDocument(document);
        
        // Enrich with lightweight concept extraction
        const concepts = await this.extractBasicConcepts(document);
        
        // Store both for flexibility
        return {
            chunks,        // For predictable vector search
            concepts,      // For bitmap tagging
            metadata: {
                ...document.metadata,
                concepts: concepts,
                bitmapTags: this.generateBitmapTags(concepts)
            }
        };
    }
}
```

#### 2.2 Functional Query Refinement (Not Stateful)
```javascript
// Avoid stateful sessions - use functional approach
function refineQuery(baseContext, refinements) {
    return {
        bitmaps: computeNewBitmaps(baseContext.bitmaps, refinements),
        concepts: mergeConceptSets(baseContext.concepts, refinements),
        timestamp: Date.now() // For cache invalidation
    };
}
```

### Phase 3: Proper Architecture Separation

#### 3.1 Indexing Pipeline
```javascript
class IndexingPipeline {
    constructor() {
        this.stages = [
            new DocumentNormalizer(),
            new ConceptExtractor(),
            new ChunkGenerator(),
            new EmbeddingGenerator(),
            new BitmapTagger()
        ];
    }
    
    async process(document) {
        return await this.stages.reduce(async (doc, stage) => {
            return await stage.process(await doc);
        }, document);
    }
}
```

#### 3.2 Query Planner
```javascript
class QueryPlanner {
    async plan(query, context) {
        // 1. Parse query into concepts
        const concepts = await this.parseQuery(query);
        
        // 2. Generate bitmap filters from context tree
        const bitmapFilter = this.generateBitmapFilter(concepts, context);
        
        // 3. Estimate result set size
        const estimate = await this.estimateResults(bitmapFilter);
        
        // 4. Choose strategy based on estimate
        const VECTOR_THRESHOLD = 10000; // Tune based on performance testing
        
        return estimate > VECTOR_THRESHOLD 
            ? new BitmapFirstStrategy(bitmapFilter)
            : new VectorFirstStrategy(concepts);
    }
}
```

#### 3.3 Multi-Stage Retriever
```javascript
class MultiStageRetriever {
    async retrieve(query, options = {}) {
        const plan = await this.planner.plan(query, options.context);
        
        // Stage 1: Bitmap filtering using existing tree structure
        const candidateIds = await plan.getBitmapCandidates();
        
        // Stage 2: Vector search within candidates
        const vectorResults = await this.vectorIndex.search(
            query.embedding,
            { preFilter: candidateIds }
        );
        
        // Stage 3: Re-ranking based on concepts
        return this.reranker.rank(vectorResults, query.concepts);
    }
}
```

### Phase 4: Enhanced Document Schema

#### 4.1 Metadata Extensions
```javascript
// Extend BaseDocument metadata for RAG support
metadata: {
    // Existing fields...
    contentType: string,
    contentEncoding: string,
    dataPaths: string[],
    
    // Concept extraction results
    concepts: {
        entities: [],       // Named entities (people, places, organizations)
        topics: [],         // High-level topics
        factoids: [],       // Specific facts (e.g., "Declaration signed in 1776")
        temporalRefs: [],   // Time references
        spatialRefs: []     // Location references
    },
    
    // Bitmap tagging for context tree
    bitmapTags: {
        automatic: [],      // System-generated from content
        manual: [],         // User-defined tags
        derived: [],        // Inferred from context tree position
        contextPaths: []    // e.g., ["/work/acmeorg/devops"]
    },
    
    // Processing metadata
    processing: {
        lastIndexed: Date,
        indexVersion: string,
        embeddingModel: string,
        conceptModel: string,
        chunkingStrategy: string
    }
}
```

## Performance Optimizations

### 1. Bitmap Caching
```javascript
class BitmapCache {
    constructor(maxSize = 1000) {
        this.cache = new LRUCache({ max: maxSize });
        this.preloadFrequent();
    }
    
    async preloadFrequent() {
        // Keep frequently accessed context bitmaps hot
        const frequentContexts = [
            '/work', '/personal', '/research'
        ];
        // Preload bitmap collections for common contexts
    }
}
```

### 2. Vector Operation Batching
```javascript
class BatchedVectorSearch {
    constructor(batchSize = 100) {
        this.batchSize = batchSize;
        this.pending = [];
    }
    
    async search(embedding, filters) {
        // Batch multiple searches together
        return this.addToBatch({ embedding, filters });
    }
}
```

### 3. Index Type Selection
- **HNSW**: Use for high-accuracy requirements (default)
- **IVF**: Use for speed when dealing with millions of documents
- **Hybrid**: HNSW for recent/hot data, IVF for cold storage

## Implementation Priority

### Immediate (MVP):
1. ✅ Complete browser extension update for new API
2. ✅ Ensure context switching works with existing bitmap tree
3. ✅ Basic document CRUD operations

### Next Sprint:
1. ⏳ Basic chunking implementation
2. ⏳ Simple embedding generation (one model)
3. ⏳ Integration between bitmap filters and vector search

### Future Sprints:
1. 🔮 Concept extraction pipeline
2. 🔮 Query planner implementation
3. 🔮 Multi-stage retrieval
4. 🔮 Advanced re-ranking

## Potential Pitfalls to Avoid

1. **Don't over-engineer concept extraction** - Start with simple NLP, not complex ML
2. **Avoid stateful query sessions** - Memory management nightmare
3. **Don't index everything as vectors** - Use bitmaps for categorical data
4. **Keep chunking strategy simple** - Complexity !== better retrieval
5. **Version your indexes** - You'll need to reindex as you improve

## Integration with Existing System

The bitmap-powered context tree (`/work/acmeorg/devops/task-1234`) is already perfect for:
- Pre-filtering documents by context
- Hierarchical permission checking
- Fast context switching
- Natural user mental model

RAG should enhance, not replace this system:
```javascript
// Example: Finding documents about "kubernetes" in current context
const context = "/work/acmeorg/devops";
const bitmapFilter = await getBitmapForContext(context);
const k8sDocs = await vectorSearch("kubernetes", { 
    preFilter: bitmapFilter 
});
```

## Conclusion

The proposed architecture is solid but needs phased implementation. Focus on:
1. **Ship MVP first** - Browser extension with basic functionality
2. **Leverage existing strengths** - Bitmap tree for context filtering
3. **Add RAG incrementally** - Start simple, measure, iterate
4. **Maintain simplicity** - Complex != better for users

Remember: The best architecture is one that ships and serves users, not one that wins design awards. 
