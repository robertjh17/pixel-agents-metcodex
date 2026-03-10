import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	parseCodexSessionMetaLine,
	readFirstLineFromFile,
} from './codexSessionMeta.js';

const TMP_PREFIX = 'pixel-agents-codex-meta-';

function withTempFile(contents: string, run: (filePath: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
	const filePath = path.join(dir, 'session.jsonl');
	try {
		fs.writeFileSync(filePath, contents, 'utf-8');
		run(filePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function buildSessionMetaLine(extraTextLength = 0): string {
	return JSON.stringify({
		type: 'session_meta',
		payload: {
			id: 'session-123',
			cwd: 'C:\\workspace',
			originator: 'codex_vscode',
			timestamp: '2026-03-10T12:00:00.000Z',
			base_instructions: {
				text: 'x'.repeat(extraTextLength),
			},
		},
	});
}

test('parses a normal session_meta first line', () => {
	withTempFile(`${buildSessionMetaLine()}\n{"type":"event_msg"}`, (filePath) => {
		const firstLine = readFirstLineFromFile(filePath, 4096);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		assert.equal(parsed.kind, 'ok');
		if (parsed.kind === 'ok') {
			assert.equal(parsed.meta.sessionId, 'session-123');
			assert.equal(parsed.meta.cwd, 'C:\\workspace');
		}
	});
});

test('parses a large session_meta line beyond 4096 bytes', () => {
	withTempFile(`${buildSessionMetaLine(12000)}\n{"type":"event_msg"}`, (filePath) => {
		const firstLine = readFirstLineFromFile(filePath, 256 * 1024);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		assert.equal(parsed.kind, 'ok');
	});
});

test('marks an incomplete first line as incomplete', () => {
	withTempFile(buildSessionMetaLine(12000), (filePath) => {
		const firstLine = readFirstLineFromFile(filePath, 4096);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		assert.equal(parsed.kind, 'incomplete');
	});
});

test('rejects a valid json first line that is not session_meta', () => {
	withTempFile('{"type":"response_item","payload":{"type":"message"}}\n', (filePath) => {
		const firstLine = readFirstLineFromFile(filePath, 4096);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		assert.equal(parsed.kind, 'not_session_meta');
	});
});

test('rejects malformed json in the first line', () => {
	withTempFile('{"type":"session_meta","payload":\n', (filePath) => {
		const firstLine = readFirstLineFromFile(filePath, 4096);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		assert.equal(parsed.kind, 'invalid_json');
	});
});
