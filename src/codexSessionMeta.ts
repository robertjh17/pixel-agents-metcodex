import * as fs from 'fs';

export interface ParsedCodexSessionMeta {
	sessionId: string;
	cwd: string;
	originator?: string;
	timestamp?: string;
}

export type CodexSessionMetaParseResult =
	| { kind: 'ok'; meta: ParsedCodexSessionMeta }
	| { kind: 'empty' }
	| { kind: 'incomplete' }
	| { kind: 'invalid_json' }
	| { kind: 'not_session_meta' }
	| { kind: 'missing_fields' };

export function readFirstLineFromFile(
	filePath: string,
	maxBytes: number,
): { line: string | null; isComplete: boolean } {
	const fd = fs.openSync(filePath, 'r');
	try {
		return readFirstLineFromFd(fd, maxBytes);
	} finally {
		fs.closeSync(fd);
	}
}

export function readFirstLineFromFd(
	fd: number,
	maxBytes: number,
): { line: string | null; isComplete: boolean } {
	const chunkSize = Math.min(4096, maxBytes);
	const chunks: Buffer[] = [];
	let offset = 0;

	while (offset < maxBytes) {
		const nextChunkSize = Math.min(chunkSize, maxBytes - offset);
		const buffer = Buffer.alloc(nextChunkSize);
		const bytesRead = fs.readSync(fd, buffer, 0, nextChunkSize, offset);
		if (bytesRead <= 0) {
			break;
		}

		const chunk = buffer.subarray(0, bytesRead);
		const newlineIndex = chunk.indexOf(0x0a);
		if (newlineIndex !== -1) {
			chunks.push(chunk.subarray(0, newlineIndex));
			return {
				line: Buffer.concat(chunks).toString('utf-8').replace(/\r$/, ''),
				isComplete: true,
			};
		}

		chunks.push(chunk);
		offset += bytesRead;
	}

	if (chunks.length === 0) {
		return { line: null, isComplete: true };
	}

	return {
		line: Buffer.concat(chunks).toString('utf-8').replace(/\r$/, ''),
		isComplete: offset < maxBytes,
	};
}

export function parseCodexSessionMetaLine(
	line: string | null,
	isComplete: boolean,
): CodexSessionMetaParseResult {
	const trimmed = line?.trim();
	if (!trimmed) {
		return { kind: 'empty' };
	}
	if (!isComplete) {
		return { kind: 'incomplete' };
	}

	let record: { type?: string; payload?: Record<string, unknown> };
	try {
		record = JSON.parse(trimmed) as { type?: string; payload?: Record<string, unknown> };
	} catch {
		return { kind: 'invalid_json' };
	}

	if (record.type !== 'session_meta') {
		return { kind: 'not_session_meta' };
	}

	const sessionId = typeof record.payload?.id === 'string' ? record.payload.id : null;
	const cwd = typeof record.payload?.cwd === 'string' ? record.payload.cwd : null;
	if (!sessionId || !cwd) {
		return { kind: 'missing_fields' };
	}

	return {
		kind: 'ok',
		meta: {
			sessionId,
			cwd,
			originator: typeof record.payload?.originator === 'string' ? record.payload.originator : undefined,
			timestamp: typeof record.payload?.timestamp === 'string' ? record.payload.timestamp : undefined,
		},
	};
}
