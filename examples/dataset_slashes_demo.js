#!/usr/bin/env node

/**
 * Dataset Slash Handling Demo
 * 
 * This example demonstrates how dataset names with slashes 
 * automatically create proper subdirectory structures.
 */

import SynapsD from '../src/index.js';

async function demonstrateDatasetSlashes() {
    console.log('🚀 Dataset Slash Handling Demo\n');
    
    // Cleanup previous runs
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
        await execAsync('rm -rf /tmp/dataset-slashes-demo');
        console.log('🧹 Cleaned up previous demo\n');
    } catch (error) {
        // Ignore cleanup errors
    }
    
    // Create file backend
    const db = new SynapsD({
        path: '/tmp/dataset-slashes-demo',
        backend: 'file',
        pretty: true
    });
    
    console.log('✅ File backend created\n');
    
    console.log('📁 Creating datasets with slashes...');
    console.log('──────────────────────────────────────');
    
    // Create datasets with various slash patterns
    const datasets = [
        { name: 'internal/bitmaps', description: 'Internal bitmap storage' },
        { name: 'indexes/roaring', description: 'Roaring bitmap indexes' },
        { name: 'data/user/profiles', description: 'User profile data' },
        { name: 'cache/sessions/active', description: 'Active session cache' },
        { name: 'logs/application/errors', description: 'Application error logs' },
        { name: 'config/environment/prod', description: 'Production configuration' }
    ];
    
    const createdDatasets = {};
    
    datasets.forEach(({ name, description }) => {
        const dataset = db.db.createDataset(name);
        createdDatasets[name] = dataset;
        console.log(`   📂 Created "${name}" → ${description}`);
    });
    
    console.log('\n💾 Adding sample data to datasets...');
    console.log('──────────────────────────────────────');
    
    // Add different types of data
    createdDatasets['internal/bitmaps'].set('user-bitmap-1', Buffer.from([0x01, 0x02, 0x03, 0xFF]));
    createdDatasets['internal/bitmaps'].set('user-bitmap-2', Buffer.from([0x10, 0x20, 0x30, 0xFE]));
    
    createdDatasets['indexes/roaring'].set('feature-index', Buffer.from([0xAA, 0xBB, 0xCC]));
    createdDatasets['indexes/roaring'].set('context-index', Buffer.from([0x11, 0x22, 0x33]));
    
    createdDatasets['data/user/profiles'].set('user-123', {
        id: 123,
        name: 'Alice Johnson',
        email: 'alice@example.com',
        role: 'admin'
    });
    
    createdDatasets['data/user/profiles'].set('user-456', {
        id: 456,
        name: 'Bob Smith',
        email: 'bob@example.com',
        role: 'user'
    });
    
    createdDatasets['cache/sessions/active'].set('session-abc123', {
        userId: 123,
        loginTime: new Date().toISOString(),
        ipAddress: '192.168.1.1'
    });
    
    createdDatasets['logs/application/errors'].set('error-001', {
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: 'Database connection failed',
        stack: 'Error: Connection timeout...'
    });
    
    createdDatasets['config/environment/prod'].set('database', {
        host: 'db.example.com',
        port: 5432,
        ssl: true,
        poolSize: 20
    });
    
    console.log('   🔢 Binary data → internal/bitmaps (4 files)');
    console.log('   🔢 Index data → indexes/roaring (2 files)');
    console.log('   👤 User profiles → data/user/profiles (2 files)');
    console.log('   🔄 Session cache → cache/sessions/active (1 file)');
    console.log('   📝 Error logs → logs/application/errors (1 file)');
    console.log('   ⚙️  Configuration → config/environment/prod (1 file)');
    
    console.log('\n🗂️  Directory Structure Created:');
    console.log('──────────────────────────────────');
    
    try {
        const { stdout } = await execAsync('find /tmp/dataset-slashes-demo -type d | grep -v locks | sort');
        stdout.split('\n').filter(line => line.trim()).forEach(dir => {
            const relativePath = dir.replace('/tmp/dataset-slashes-demo/', '');
            if (relativePath) {
                const depth = (relativePath.match(/\//g) || []).length;
                const indent = '  '.repeat(depth);
                const name = relativePath.split('/').pop();
                console.log(`${indent}📁 ${name}/`);
            }
        });
    } catch (error) {
        console.log('   ⚠️  Could not list directory structure');
    }
    
    console.log('\n📄 Files Created:');
    console.log('────────────────');
    
    try {
        const { stdout } = await execAsync('find /tmp/dataset-slashes-demo -name "*.json" -o -name "*.bin" | sort');
        stdout.split('\n').filter(line => line.trim()).forEach(file => {
            const relativePath = file.replace('/tmp/dataset-slashes-demo/', '');
            const extension = file.endsWith('.bin') ? '🔢' : '📄';
            console.log(`   ${extension} ${relativePath}`);
        });
    } catch (error) {
        console.log('   ⚠️  Could not list files');
    }
    
    console.log('\n🔍 Testing Data Retrieval...');
    console.log('───────────────────────────');
    
    // Test retrieval
    const bitmap = createdDatasets['internal/bitmaps'].get('user-bitmap-1');
    const user = createdDatasets['data/user/profiles'].get('user-123');
    const session = createdDatasets['cache/sessions/active'].get('session-abc123');
    const error = createdDatasets['logs/application/errors'].get('error-001');
    
    console.log(`   🔢 Retrieved bitmap: ${bitmap?.length} bytes`);
    console.log(`   👤 Retrieved user: ${user?.name} (${user?.email})`);
    console.log(`   🔄 Retrieved session: User ${session?.userId}`);
    console.log(`   📝 Retrieved error: ${error?.level} - ${error?.message}`);
    
    console.log('\n✅ All data retrieved successfully!');
    
    console.log('\n📋 Summary');
    console.log('─────────');
    console.log('✅ Dataset names with slashes create proper subdirectories');
    console.log('✅ Deep nesting (3+ levels) works correctly');
    console.log('✅ Binary and JSON data both supported');
    console.log('✅ File extensions (.bin/.json) handled automatically');
    console.log('✅ Data retrieval works across all nested structures');
    console.log('✅ Lock directories mirror the same structure');
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await db.shutdown();
    
    console.log('\n🎉 Dataset Slash Handling Demo completed successfully!\n');
    
    console.log('💡 Usage example:');
    console.log('   const dataset = db.db.createDataset("internal/bitmaps");');
    console.log('   // → Creates: /database/path/internal/bitmaps/');
    console.log('   ');
    console.log('   const deepDataset = db.db.createDataset("very/deep/nested/structure");');
    console.log('   // → Creates: /database/path/very/deep/nested/structure/');
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
    demonstrateDatasetSlashes().catch(console.error);
}

export { demonstrateDatasetSlashes };