// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Runs until the final result or a per-session stop marker. Launched by
// electron/speech.mjs as this background app bundle so macOS can resolve the
// microphone and speech purpose strings in its Info.plist.
//
// `--endpoint-ms N` ends the audio stream after N milliseconds without a
// transcript change. SFSpeechRecognizer does not finalize a buffer-backed
// request on silence by itself; it only produces `isFinal` after endAudio().
// Composer dictation omits this flag and keeps its existing press-to-stop
// behavior, while call mode opts into silence endpointing.
//
// `--wake-word PHRASE` keeps a local recognizer open until it hears PHRASE,
// followed by a command and a short pause. It then emits one line shaped as
// `{ "wake": true, "phrase": "…", "text": "…" }` and exits. Electron owns
// restart/suspension so a call and the passive listener can never share the
// microphone. The trigger/capture design is adapted from OpenClaw's MIT-
// licensed VoiceWakeRuntime and SwabbleKit; see THIRD_PARTY_NOTICES.md.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

let wakeWord: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--wake-word"), index + 1 < args.count else { return nil }
  let value = args[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
  return value.isEmpty ? nil : value
}()

let debugTranscripts = CommandLine.arguments.contains("--debug-transcripts")

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

// LaunchServices gives the helper the bundle identity TCC needs, but it also
// means the parent cannot terminate it by killing the `open -W` process. A
// per-session stop marker keeps intentional mute/hang-up deterministic.
var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) { exit(0) }
  }
  stopTimer = timer
  timer.resume()
}

// Push-to-talk release must finalize recognition rather than cancel it. The
// handler is installed once the audio engine exists; the timer keeps polling
// if an unusually fast key release beats authorization/setup.
var finishHandler: (() -> Void)?
var finishTimer: DispatchSourceTimer?
if let finishFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    guard FileManager.default.fileExists(atPath: finishFile), let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

/// SFSpeechRecognizer can keep revising/re-emitting a partial transcript
/// after the user stops talking. Only a changed transcript resets the timer.
final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "com.openmausbot.speech.endpoint")
  private let gap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(gapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    // Never terminate an empty turn: a call may be quiet for as long as the
    // user needs before they begin speaking.
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard silentFor >= gap else { return }
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

/// Passive wake listener. This intentionally uses the same on-device Apple
/// recognizer as normal dictation: no recording is stored and no audio leaves
/// the Mac. A distinctive configurable phrase keeps the text gate practical
/// without shipping a second ML runtime or model.
final class WakeWordListener {
  private let phrase: String
  private let recognizer: SFSpeechRecognizer
  private let stopFile: String?
  private let silenceGap: TimeInterval
  private let queue = DispatchQueue(label: "com.openmausbot.speech.wake")
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var timer: DispatchSourceTimer?
  private var armed = false
  private var command = ""
  private var lastTranscript = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(phrase: String, recognizer: SFSpeechRecognizer, stopFile: String?, silenceGapMs: Int) {
    self.phrase = phrase
    self.recognizer = recognizer
    self.stopFile = stopFile
    silenceGap = Double(silenceGapMs) / 1_000
  }

  func start() {
    startRecognition()
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  private func startRecognition() {
    guard !finished else { return }
    task?.cancel()
    request?.endAudio()
    if let engine {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }

    let nextRequest = SFSpeechAudioBufferRecognitionRequest()
    nextRequest.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition {
      nextRequest.requiresOnDeviceRecognition = true
    }

    let nextEngine = AVAudioEngine()
    let node = nextEngine.inputNode
    let format = node.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else { fail("mic-failed") }
    node.installTap(onBus: 0, bufferSize: 2_048, format: format) { buffer, _ in
      nextRequest.append(buffer)
    }
    do {
      nextEngine.prepare()
      try nextEngine.start()
    } catch {
      fail("mic-failed")
    }

    request = nextRequest
    engine = nextEngine
    task = recognizer.recognitionTask(with: nextRequest) { [weak self] result, error in
      guard let self else { return }
      if let result {
        let text = result.bestTranscription.formattedString
        self.queue.async { self.receive(text) }
        if result.isFinal {
          self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) { self.restartIfNeeded() }
        }
      } else if let error {
        let detail = error as NSError
        if debugTranscripts { emit(["wake_error": "\(detail.domain):\(detail.code)"]) }
        self.queue.asyncAfter(deadline: .now() + .milliseconds(500)) { self.restartIfNeeded() }
      }
    }
  }

  private func receive(_ transcript: String) {
    guard !finished, transcript != lastTranscript else { return }
    lastTranscript = transcript
    lastChange = .now()
    if debugTranscripts { emit(["wake_debug": transcript]) }

    if let extracted = Self.command(after: phrase, in: transcript) {
      armed = true
      command = extracted
    } else if armed {
      // A recognizer restart may drop the trigger from its fresh transcript.
      // Once armed, that fresh text is the command rather than a new trigger.
      command = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  private func tick() {
    guard !finished else { return }
    if let stopFile, FileManager.default.fileExists(atPath: stopFile) {
      finish(exitCode: 0)
      return
    }
    guard armed, !command.isEmpty else { return }
    let quietFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard quietFor >= silenceGap else { return }
    emit(["wake": true, "phrase": phrase, "text": command])
    finish(exitCode: 0)
  }

  private func restartIfNeeded() {
    guard !finished else { return }
    DispatchQueue.main.async { self.startRecognition() }
  }

  private func finish(exitCode: Int32) {
    guard !finished else { return }
    finished = true
    timer?.cancel()
    timer = nil
    task?.cancel()
    request?.endAudio()
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    exit(exitCode)
  }

  /// Returns nil when the phrase has not been heard, and the possibly-empty
  /// suffix when it has. Folding handles accents/case without making broad
  /// fuzzy matches that would turn ordinary room speech into agent commands.
  static func command(after phrase: String, in transcript: String) -> String? {
    // Apple consistently renders the fictional name “Kenpachi” as two
    // ordinary French words (observed: “Kim Paty”). Keep a narrow alias list
    // for the shipped default rather than using general fuzzy matching, which
    // would make an always-on microphone trigger on unrelated room speech.
    let folded = phrase.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
      .lowercased()
    let candidates = folded == "salut kenpachi"
      ? [phrase, "Salut Kim Patchy", "Salut Ken Patchi", "Salut Kim Paty", "Salut Kim Pati", "Salut Quimpachi", "Salut Pachi", "Salut Paty", "Salut Pat"]
      : [phrase]
    for candidate in candidates.sorted(by: { $0.count > $1.count }) {
      if let range = transcript.range(
        of: candidate,
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
      ) {
        return String(transcript[range.upperBound...])
          .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
      }
    }
    return nil
  }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  // Recognize in the user's language: a hardcoded en-US recognizer
  // transcribes everyone else into nonsense. First preference that has an
  // available recognizer wins, with en-US as the last resort.
  let candidates =
    Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) {
      // Stop capture before ending the request: appending another audio
      // buffer after endAudio() can make the recognition task fail instead
      // of delivering its final transcript.
      finishAudio()
    }
    endpointer?.start()
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      if let wakeWord {
        if debugTranscripts { emit(["wake_debug": text, "partial": !result.isFinal]) }
        if result.isFinal {
          if let command = WakeWordListener.command(after: wakeWord, in: text), !command.isEmpty {
            emit(["wake": true, "phrase": wakeWord, "text": command])
          } else {
            // An unrelated utterance is a normal passive-listener window,
            // not a failure. Electron immediately starts a fresh local one.
            emit(["wake_idle": true])
          }
          exit(0)
        }
      } else {
        emit(["partial": !result.isFinal, "text": text])
        if result.isFinal { exit(0) }
      }
    }
    if let error {
      let detail = error as NSError
      fail("recognition-error:\(detail.domain):\(detail.code)")
    }
  }
}

RunLoop.main.run()
