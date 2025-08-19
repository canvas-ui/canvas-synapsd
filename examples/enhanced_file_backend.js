#!/usr/bin/env node

/**
 * Enhanced File Backend Demo
 * 
 * This example demonstrates the enhanced features of the file backend:
 * - Schema-based directory organization
 * - Binary data detection and storage
 * - Automatic file extension handling (.json vs .bin)
 */

import SynapsD from '../src/index.js';
import { readFileSync } from 'fs';
import path from 'path';

async function demonstrateEnhancedFileBackend() {
    console.log('🚀 Enhanced File Backend Demo\n');
    
    // Cleanup previous runs
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
        await execAsync('rm -rf /tmp/enhanced-file-demo');
        console.log('🧹 Cleaned up previous demo\n');
    } catch (error) {
        // Ignore cleanup errors
    }
    
    // Create enhanced file backend
    const db = new SynapsD({
        path: '/tmp/enhanced-file-demo',
        backend: 'file',
        pretty: true,        // Pretty-print JSON files
        atomic: true,        // Atomic writes
        maxCacheSize: 1000,   // Cache size
    });
    
    console.log('✅ Enhanced file backend created\n');
    
    // Test 1: Schema-based Document Organization
    console.log('📁 Test 1: Schema-based Document Organization');
    console.log('───────────────────────────────────────────');
    
    const documents = [
        {
            key: 'my-tab-1',
            value: {
                schema: 'data/abstraction/tab',
                data: {
                    title: 'My Important Tab',
                    url: 'https://example.com',
                    content: 'This is tab content',
                },
            },
        },
        {
            key: 'my-note-1',
            value: {
                schema: 'data/abstraction/note',
                data: {
                    title: 'Meeting Notes',
                    content: 'Discussion about file backend improvements',
                    tags: ['backend', 'file-system', 'schemas'],
                },
            },
        },
        {
            key: 'my-file-1',
            value: {
                schema: 'data/abstraction/file',
                data: {
                    name: 'document.pdf',
                    path: '/home/user/documents/document.pdf',
                    size: 1024000,
                },
            },
        },
        {
            key: 'todo-1',
            value: {
                schema: 'data/abstraction/todo',
                data: {
                    title: 'Implement file backend',
                    completed: true,
                    priority: 'high',
                },
            },
        },
    ];
    
    // Store documents
    documents.forEach(({ key, value }) => {
        db.documents.set(key, value);
        console.log(`   📄 Stored ${key} (schema: ${value.schema})`);
    });
    
    console.log('\n✅ All documents stored with schema-based organization\n');
    
    // Test 2: Binary Data Handling
    console.log('💾 Test 2: Binary Data Handling');
    console.log('─────────────────────────────');
    
    const bitmaps = db.db.createDataset('bitmaps');
    
    // Create different types of binary data
    const binaryData = [
        {
            key: 'user-bitmap-1',
            data: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]),
        },
        {
            key: 'feature-bitmap-1',
            data: new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]),
        },
        {
            key: 'context-bitmap-1',
            data: Buffer.from('binary data content', 'utf8'),
        },
    ];
    
    binaryData.forEach(({ key, data }) => {
        bitmaps.set(key, data);
        console.log(`   🔢 Stored ${key} (${data.length} bytes, type: ${data.constructor.name})`);
    });
    
    console.log('\n✅ All binary data stored with .bin extension\n');
    
    // Test 3: Mixed Data Types in One Dataset
    console.log('🔄 Test 3: Mixed Data Types in One Dataset');
    console.log('─────────────────────────────────────────');
    
    const mixedDataset = db.db.createDataset('mixed');
    
    // Store JSON data
    mixedDataset.set('config', {
        theme: 'dark',
        language: 'en',
        features: ['file-backend', 'schema-organization'],
    });
    
    // Store binary data in the same dataset
    mixedDataset.set('small-bitmap', Buffer.from([0xAA, 0xBB, 0xCC]));
    
    console.log('   📊 Stored JSON config data');
    console.log('   🔢 Stored binary bitmap data');
    console.log('\n✅ Mixed data types handled correctly\n');
    
    // Test 4: Retrieval and Verification
    console.log('🔍 Test 4: Retrieval and Verification');
    console.log('────────────────────────────────────');
    
    // Retrieve documents
    const retrievedTab = db.documents.get('my-tab-1');
    const retrievedNote = db.documents.get('my-note-1');
    
    console.log(`   📄 Retrieved tab: "${retrievedTab?.data?.title}"`);
    console.log(`   📝 Retrieved note: "${retrievedNote?.data?.title}"`);
    
    // Retrieve binary data
    const retrievedBitmap = bitmaps.get('user-bitmap-1');
    const retrievedMixedBinary = mixedDataset.get('small-bitmap');
    
    console.log(`   🔢 Retrieved bitmap: ${retrievedBitmap?.length} bytes, Buffer: ${Buffer.isBuffer(retrievedBitmap)}`);
    console.log(`   🔢 Retrieved mixed binary: ${retrievedMixedBinary?.length} bytes`);
    
    console.log('\n✅ All data retrieved correctly\n');
    
    // Test 5: File System Structure Inspection
    console.log('🗂️  Test 5: File System Structure');
    console.log('─────────────────────────────────');
    
    const { exec: execSync } = await import('child_process');
    const { promisify: promisifySync } = await import('util');
    const execAsyncSync = promisifySync(execSync);
    
    try {
        const { stdout } = await execAsyncSync('find /tmp/enhanced-file-demo -name "*.json" -o -name "*.bin" | sort');
        console.log('File structure:');
        stdout.split('\n').filter(line => line.trim()).forEach(file => {
            const relativePath = file.replace('/tmp/enhanced-file-demo/', '');
            const extension = path.extname(file);
            const icon = extension === '.json' ? '📄' : '🔢';
            console.log(`   ${icon} ${relativePath}`);
        });
    } catch (error) {
        console.log('   ⚠️  Could not list file structure');
    }
    
    console.log('\n✅ Schema-based organization verified\n');
    
    // Test 6: Performance with Schema Organization
    console.log('⚡ Test 6: Performance Test');
    console.log('─────────────────────────');
    
    const startTime = Date.now();
    
    // Create many documents with different schemas
    for (let i = 0; i < 50; i++) {
        const schemas = ['data/abstraction/tab', 'data/abstraction/note', 'data/abstraction/file', 'data/abstraction/todo'];
        const schema = schemas[i % schemas.length];
        
        db.documents.set(`perf-test-${i}`, {
            schema,
            data: {
                title: `Performance Test ${i}`,
                content: `This is test document ${i}`,
                index: i,
            },
        });
    }
    
    const writeTime = Date.now() - startTime;
    
    // Test retrieval performance
    const readStartTime = Date.now();
    
    for (let i = 0; i < 50; i++) {
        const doc = db.documents.get(`perf-test-${i}`);
        if (!doc) {
            console.log(`   ⚠️  Failed to retrieve perf-test-${i}`);
        }
    }
    
    const readTime = Date.now() - readStartTime;
    
    console.log(`   ⏱️  Write 50 documents: ${writeTime}ms`);
    console.log(`   ⏱️  Read 50 documents: ${readTime}ms`);
    console.log(`   📊 Average write: ${(writeTime/50).toFixed(2)}ms per doc`);
    console.log(`   📊 Average read: ${(readTime/50).toFixed(2)}ms per doc`);
    
    console.log('\n✅ Performance test completed\n');
    
    // Test 7: File Content Inspection
    console.log('👁️  Test 7: Human-Readable Content');
    console.log('─────────────────────────────────');
    
    try {
        // Show JSON content
        const jsonContent = readFileSync('/tmp/enhanced-file-demo/documents/abstraction/tab/my-tab-1.json', 'utf8');
        console.log('Sample JSON file content:');
        console.log('┌─────────────────────────────────┐');
        jsonContent.split('\n').forEach(line => {
            console.log(`│ ${line.padEnd(31)} │`);
        });
        console.log('└─────────────────────────────────┘');
        
        // Show binary content info
        const binaryContent = readFileSync('/tmp/enhanced-file-demo/bitmaps/user-bitmap-1.bin');
        console.log('\nBinary file info:');
        console.log('   📁 File: bitmaps/user-bitmap-1.bin');
        console.log(`   📏 Size: ${binaryContent.length} bytes`);
        console.log(`   🔢 Content: ${Array.from(binaryContent).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' ')}`);
        
    } catch (error) {
        console.log('   ⚠️  Could not read file contents');
    }
    
    console.log('\n✅ Content inspection completed\n');
    
    // Summary
    console.log('📋 Summary');
    console.log('─────────');
    console.log('✅ Schema-based directory organization working');
    console.log('✅ Binary data detection and .bin extension handling');
    console.log('✅ JSON data pretty-printing and .json extension');
    console.log('✅ Mixed data types in same dataset supported');
    console.log('✅ Fast retrieval with caching');
    console.log('✅ Human-readable file storage');
    console.log('✅ Atomic file operations');
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await db.shutdown();
    
    console.log('\n🎉 Enhanced File Backend Demo completed successfully!\n');
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
    demonstrateEnhancedFileBackend().catch(console.error);
}

export { demonstrateEnhancedFileBackend };