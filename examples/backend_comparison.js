#!/usr/bin/env node

/**
 * Backend Comparison Example
 * 
 * This example demonstrates the use of both LMDB and File backends
 * with the Canvas SynapsD system.
 */

import SynapsD from '../src/index.js';
import BackendFactory from '../src/backends/index.js';
import { performance } from 'perf_hooks';

// Cleanup function
async function cleanup() {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
        await execAsync('rm -rf /tmp/synapsd-*');
        console.log('🧹 Cleaned up test directories');
    } catch (error) {
        console.log('⚠️  Cleanup warning:', error.message);
    }
}

// Performance testing
function measureTime(fn, label) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    console.log(`⏱️  ${label}: ${(end - start).toFixed(2)}ms`);
    return result;
}

async function demonstrateBackends() {
    console.log('🚀 Canvas SynapsD Backend Comparison Demo\n');
    
    // Cleanup previous runs
    await cleanup();
    
    // Show available backends
    console.log('📋 Available Backends:');
    const backends = BackendFactory.getAvailableBackends();
    backends.forEach(backend => {
        const capabilities = BackendFactory.getBackendCapabilities(backend);
        console.log(`   • ${backend.toUpperCase()}: ${capabilities.performance} performance, ${capabilities.durability} durability`);
    });
    console.log();
    
    // Create database instances
    console.log('🏗️  Creating Database Instances...');
    const lmdbDb = new SynapsD({
        path: '/tmp/synapsd-lmdb-demo',
        backend: 'lmdb',
        backupOnOpen: false,
        backupOnClose: false
    });
    
    const fileDb = new SynapsD({
        path: '/tmp/synapsd-file-demo',
        backend: 'file',
        backupOnOpen: false,
        backupOnClose: false,
        pretty: true,
        maxCacheSize: 500
    });
    
    console.log('✅ Both databases created successfully\n');
    
    // Test basic operations
    console.log('🔧 Testing Basic Operations...');
    
    // Test data
    const testData = {
        schema: 'test-document',
        data: {
            title: 'Test Document',
            content: 'This is a test document for backend comparison',
            tags: ['test', 'demo', 'backend'],
            metadata: {
                created: new Date().toISOString(),
                author: 'Backend Demo'
            }
        }
    };
    
    // Performance comparison
    console.log('\n📊 Performance Comparison:');
    
    // LMDB Operations
    console.log('\n🏃 LMDB Backend:');
    measureTime(() => {
        lmdbDb.documents.set('test-doc-1', testData);
        lmdbDb.documents.set('test-doc-2', { ...testData, data: { ...testData.data, title: 'Second Document' } });
        lmdbDb.documents.set('test-doc-3', { ...testData, data: { ...testData.data, title: 'Third Document' } });
    }, 'Write 3 documents');
    
    measureTime(() => {
        const doc1 = lmdbDb.documents.get('test-doc-1');
        const doc2 = lmdbDb.documents.get('test-doc-2');
        const doc3 = lmdbDb.documents.get('test-doc-3');
        return [doc1, doc2, doc3];
    }, 'Read 3 documents');
    
    // File Backend Operations
    console.log('\n📁 File Backend:');
    measureTime(() => {
        fileDb.documents.set('test-doc-1', testData);
        fileDb.documents.set('test-doc-2', { ...testData, data: { ...testData.data, title: 'Second Document' } });
        fileDb.documents.set('test-doc-3', { ...testData, data: { ...testData.data, title: 'Third Document' } });
    }, 'Write 3 documents');
    
    measureTime(() => {
        const doc1 = fileDb.documents.get('test-doc-1');
        const doc2 = fileDb.documents.get('test-doc-2');
        const doc3 = fileDb.documents.get('test-doc-3');
        return [doc1, doc2, doc3];
    }, 'Read 3 documents');
    
    // Test dataset operations
    console.log('\n📚 Dataset Operations:');
    
    // Create custom datasets
    const lmdbCustom = lmdbDb.db.createDataset('custom-data');
    const fileCustom = fileDb.db.createDataset('custom-data');
    
    // Add some data
    lmdbCustom.set('config', { theme: 'dark', language: 'en' });
    fileCustom.set('config', { theme: 'dark', language: 'en' });
    
    lmdbCustom.set('stats', { documents: 3, users: 1 });
    fileCustom.set('stats', { documents: 3, users: 1 });
    
    console.log('✅ Custom datasets created and populated');
    
    // Show stats
    console.log('\n📈 Database Statistics:');
    console.log('LMDB Database:');
    console.log(`   • Documents: ${lmdbDb.documents.getCount()}`);
    console.log(`   • Custom entries: ${lmdbCustom.getCount()}`);
    console.log(`   • Backend: ${lmdbDb.stats.dbBackend}`);
    
    console.log('File Database:');
    console.log(`   • Documents: ${fileDb.documents.getCount()}`);
    console.log(`   • Custom entries: ${fileCustom.getCount()}`);
    console.log(`   • Backend: ${fileDb.stats.dbBackend}`);
    
    // Demonstrate file backend human-readable storage
    console.log('\n👁️  File Backend Inspection:');
    console.log('File backend creates human-readable JSON files:');
    
    try {
        const { readFileSync } = await import('fs');
        const docPath = '/tmp/synapsd-file-demo/documents/test-doc-1.json';
        const content = readFileSync(docPath, 'utf8');
        console.log('Sample document content:');
        console.log(JSON.stringify(JSON.parse(content), null, 2));
    } catch (error) {
        console.log('Could not read file:', error.message);
    }
    
    // Test transactions
    console.log('\n🔄 Transaction Testing:');
    
    try {
        await lmdbDb.db.transaction(async () => {
            lmdbDb.documents.set('tx-doc-1', testData);
            lmdbDb.documents.set('tx-doc-2', testData);
            console.log('✅ LMDB transaction completed');
        });
        
        await fileDb.db.transaction(async () => {
            fileDb.documents.set('tx-doc-1', testData);
            fileDb.documents.set('tx-doc-2', testData);
            console.log('✅ File backend transaction completed');
        });
    } catch (error) {
        console.log('❌ Transaction error:', error.message);
    }
    
    // Error handling demonstration
    console.log('\n⚠️  Error Handling Demo:');
    
    try {
        new SynapsD({
            path: '/tmp/test',
            backend: 'nonexistent'
        });
    } catch (error) {
        console.log('✅ Properly caught invalid backend:', error.message);
    }
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await lmdbDb.shutdown();
    await fileDb.shutdown();
    
    console.log('\n🎉 Demo completed successfully!');
    console.log('\n📝 Summary:');
    console.log('   • Both backends implement the same interface');
    console.log('   • LMDB provides better performance for large datasets');
    console.log('   • File backend provides human-readable storage');
    console.log('   • Backend selection is configurable at runtime');
    console.log('   • All operations are compatible between backends');
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
    demonstrateBackends().catch(console.error);
}

export { demonstrateBackends };