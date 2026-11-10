import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../dist/index.js';
import { ProjectService } from '../dist/application/project-service.js';

test('new projects opt out of non-Git scanning without migrating legacy projects', () => {
  const db = new Database(':memory:');
  try {
    const legacy = { id:'legacy',name:'Legacy',rootPath:'/unused',repositoryType:'none',frontendPaths:[],backendPaths:[],ignoredPaths:[],policyId:'default' };
    db.projects.save(legacy,new Date().toISOString());
    const service = new ProjectService(db);
    const created = service.add({rootPath:'/new',name:'New'});
    assert.equal(created.nonGitDiffMode,'off');
    assert.equal(db.projects.get(created.id).nonGitDiffMode,'off');
    assert.equal(service.list().find((project)=>project.id==='legacy').nonGitDiffMode,undefined);
    db.projects.save({...legacy,name:'Renamed'},new Date().toISOString());
    assert.equal(db.projects.get('legacy').nonGitDiffMode,undefined);
    db.projects.save({...created,nonGitDiffMode:'full'},new Date().toISOString());
    assert.equal(db.projects.get(created.id).nonGitDiffMode,'full');
  } finally { db.close(); }
});

test('scan merges inspection into latest settings instead of restoring a stale project snapshot', () => {
  const db = new Database(':memory:');
  try {
    const service = new ProjectService(db);
    const original = service.add({ rootPath: '/original', name: 'Old name' });
    db.projects.save({ ...original, nonGitDiffMode: 'full' }, new Date().toISOString());
    service.inspector.inspect = () => {
      db.projects.save({ ...original, name: 'New name', nonGitDiffMode: 'off', policyId: 'custom-policy' }, new Date().toISOString());
      return { git: { isRepo: false }, frontendPaths: ['ui'], backendPaths: ['api'], scannedAt: new Date().toISOString() };
    };
    const { project } = service.scan(original.id);
    assert.equal(project.name, 'New name');
    assert.equal(project.nonGitDiffMode, 'off');
    assert.equal(project.policyId, 'custom-policy');
    assert.deepEqual(project.frontendPaths, ['ui']);
    assert.equal(db.projects.get(original.id).nonGitDiffMode, 'off');
  } finally { db.close(); }
});

test('scan rejects stale inspection after project directory changes', () => {
  const db = new Database(':memory:');
  try {
    const service = new ProjectService(db);
    const original = service.add({ rootPath: '/original' });
    service.inspector.inspect = () => {
      db.projects.save({ ...original, rootPath: '/replacement', frontendPaths: ['keep'] }, new Date().toISOString());
      return { git: { isRepo: true }, frontendPaths: ['stale'], backendPaths: [], scannedAt: new Date().toISOString() };
    };
    assert.throws(() => service.scan(original.id), (error) => error.descriptor?.code === 'IPC_INVALID_REQUEST');
    assert.equal(db.projects.get(original.id).rootPath, '/replacement');
    assert.deepEqual(db.projects.get(original.id).frontendPaths, ['keep']);
  } finally { db.close(); }
});
