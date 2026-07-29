import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from '../../src/index.js';

// ALAC demuxing. The fixtures are generated (not collected) by mediaplay's
// scripts/gen-alac-corpus.mjs: short synthetic tones encoded with macOS's afconvert, each
// channel carrying its own frequency. They are verified there to decode sample-exactly, so
// what they assert here is only what the demuxer should see.
//
// The corpus lives outside this repository, so these skip when it is absent.

const CORPUS = join(__dirname, '../../../mediaplay/test-corpus/alac');
const hasCorpus = existsSync(join(CORPUS, 'manifest.json'));

type Fixture = {
	file: string;
	channels: number;
	rate: number;
	bits: number;
	frames: number;
};

const manifest: Fixture[] = hasCorpus
	? JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8')) as Fixture[]
	: [];

describe.skipIf(!hasCorpus)('ALAC', () => {
	for (const fx of manifest) {
		it(`demuxes ${fx.file}`, async () => {
			const bytes = new Uint8Array(readFileSync(join(CORPUS, fx.file)));
			const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });

			const track = await input.getPrimaryAudioTrack();
			expect(track).toBeTruthy();
			expect(track!.codec).toBe('alac');

			// The sample entry claims two channels for every ALAC file and cannot express a
			// sample rate above 65535, so both of these come from the magic cookie instead.
			// The mono and 5.1/7.1 fixtures are what make that visible.
			expect(track!.numberOfChannels).toBe(fx.channels);
			expect(track!.sampleRate).toBe(fx.rate);

			// The cookie itself: 24 bytes of ALACSpecificConfig, with the FullBox version and
			// flags stripped. Without it a decoder cannot be configured at all.
			const config = await track!.getDecoderConfig();
			expect(config).toBeTruthy();
			expect(config!.description).toBeTruthy();
			const cookie = new Uint8Array(config!.description as ArrayBuffer);
			expect(cookie.byteLength).toBe(24);
			expect(cookie[9]).toBe(fx.channels); // numChannels
			expect(cookie[5]).toBe(fx.bits); // bitDepth

			// And the packets are readable, in the number the frame length implies.
			const sink = new EncodedPacketSink(track!);
			let packets = 0;
			let totalBytes = 0;
			for await (const packet of sink.packets()) {
				packets++;
				totalBytes += packet.data.byteLength;
			}
			const frameLength = 4096; // what afconvert writes, and what the cookie says
			expect(packets).toBe(Math.ceil(fx.frames / frameLength));
			expect(totalBytes).toBeGreaterThan(0);
		});
	}
});
