/* global module */

var util = require('util');
var hark = require('hark');
var getScreenMedia = require('./getscreenmedia');
var WildEmitter = require('wildemitter');
var mockconsole = require('mockconsole');

function isAllTracksEnded(stream) {
	var isAllTracksEnded = true;
	stream.getTracks().forEach(function (t) {
		isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
	});
	return isAllTracksEnded;
}

function LocalMedia(opts) {
	WildEmitter.call(this);

	var config = this.config = {
		detectSpeakingEvents: false,
		audioFallback: false,
		media: {
			audio: true,
			video: true
		},
		harkOptions: null,
		logger: mockconsole
	};

	var item;
	for (item in opts) {
		if (opts.hasOwnProperty(item)) {
			this.config[item] = opts[item];
		}
	}

	this.logger = config.logger;
	this._log = this.logger.log.bind(this.logger, 'LocalMedia:');
	this._logerror = this.logger.error.bind(this.logger, 'LocalMedia:');

	this.localStreams = [];
	this._audioMonitorStreams = [];
	this.localScreens = [];

	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		this._logerror('Your browser does not support local media capture.');
	}

	this._audioMonitors = [];
	this.on('localScreenStopped', this._stopAudioMonitor.bind(this));
}

util.inherits(LocalMedia, WildEmitter);

/**
 * Clones a MediaStream that will be ended when the original MediaStream is
 * ended.
 */
var cloneLinkedStream = function(stream) {
	var linkedStream = new MediaStream();

	stream.getTracks().forEach(function (track) {
		var linkedTrack = track.clone();
		linkedStream.addTrack(linkedTrack);

		// Keep a reference of all the linked clones of a track to be able to
		// stop them when the track is stopped.
		if (!track.linkedTracks) {
			track.linkedTracks = [];
		}
		track.linkedTracks.push(linkedTrack);

		track.addEventListener('ended', function () {
			linkedTrack.stop();
		});
	});

	return linkedStream;
};

LocalMedia.prototype.start = function (mediaConstraints, cb) {
	var self = this;
	var constraints = mediaConstraints || this.config.media;

	if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		var error = new Error('MediaStreamError');
		error.name = 'NotSupportedError';

		if (cb) {
			return cb(error, null);
		}

		return;
	}

	this.emit('localStreamRequested', constraints);

	navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
		// Although the promise should be resolved only if all the constraints
		// are met Edge resolves it if both audio and video are requested but
		// only audio is available.
		if (constraints.video && stream.getVideoTracks().length === 0) {
			constraints.video = false;
			self.start(constraints, cb);
			return;
		}

		// The audio monitor stream is never disabled to be able to analyze it
		// even when the stream sent is muted.
		var audioMonitorStream = cloneLinkedStream(stream);
		if (constraints.audio && self.config.detectSpeakingEvents) {
			self._setupAudioMonitor(audioMonitorStream, self.config.harkOptions);
		}
		self.localStreams.push(stream);
		self._audioMonitorStreams.push(audioMonitorStream);

		stream.getTracks().forEach(function (track) {
			track.addEventListener('ended', function () {
				if (isAllTracksEnded(stream)) {
					self._removeStream(stream);
				}
			});
		});

		self.emit('localStream', stream);

		if (cb) {
			return cb(null, stream);
		}
	}).catch(function (err) {
			// Fallback for users without a camera
			if (self.config.audioFallback && err.name === 'NotFoundError' && constraints.video !== false) {
				constraints.video = false;
				self.start(constraints, cb);
				return;
			}

		self.emit('localStreamRequestFailed', constraints);

		if (cb) {
			return cb(err, null);
		}
	});
};

LocalMedia.prototype.stop = function (stream) {
	this.stopStream(stream);
	this.stopScreenShare(stream);
};

LocalMedia.prototype.stopStream = function (stream) {
	var self = this;

	if (stream) {
		var idx = this.localStreams.indexOf(stream);
		if (idx > -1) {
			stream.getTracks().forEach(function (track) {
				track.stop();

				// Linked tracks must be explicitly stopped, as stopping a track
				// does not trigger the "ended" event, and due to a bug in
				// Firefox it is not possible to explicitly dispatch the event
				// either (nor any other event with a different name):
				// https://bugzilla.mozilla.org/show_bug.cgi?id=1473457
				if (track.linkedTracks) {
					track.linkedTracks.forEach(function(linkedTrack) {
						linkedTrack.stop();
					});
				}
			});
			this._removeStream(stream);
		}
	} else {
		this.localStreams.forEach(function (stream) {
			stream.getTracks().forEach(function (track) {
				track.stop();

				// Linked tracks must be explicitly stopped, as stopping a track
				// does not trigger the "ended" event, and due to a bug in
				// Firefox it is not possible to explicitly dispatch the event
				// either (nor any other event with a different name):
				// https://bugzilla.mozilla.org/show_bug.cgi?id=1473457
				if (track.linkedTracks) {
					track.linkedTracks.forEach(function(linkedTrack) {
						linkedTrack.stop();
					});
				}
			});
			self._removeStream(stream);
		});
	}
};

LocalMedia.prototype.startScreenShare = function (mode, constraints, cb) {
	var self = this;

	this.emit('localScreenRequested');

	if (typeof constraints === 'function' && !cb) {
		cb = constraints;
		constraints = null;
	}

	getScreenMedia(mode, constraints, function (err, stream) {
		if (!err) {
			self.localScreens.push(stream);

			stream.getTracks().forEach(function (track) {
				track.addEventListener('ended', function () {
					var isAllTracksEnded = true;
					stream.getTracks().forEach(function (t) {
						isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
					});

					if (isAllTracksEnded) {
						self._removeStream(stream);
					}
				});
			});

			self.emit('localScreen', stream);
		} else {
			self.emit('localScreenRequestFailed');
		}

		// enable the callback
		if (cb) {
			return cb(err, stream);
		}
	});
};

LocalMedia.prototype.stopScreenShare = function (stream) {
	var self = this;

	if (stream) {
		var idx = this.localScreens.indexOf(stream);
		if (idx > -1) {
			stream.getTracks().forEach(function (track) { track.stop(); });
			this._removeStream(stream);
		}
	} else {
		this.localScreens.forEach(function (stream) {
			stream.getTracks().forEach(function (track) { track.stop(); });
			self._removeStream(stream);
		});
	}
};

// Audio controls
LocalMedia.prototype.mute = function () {
	this._setAudioEnabled(false);
	this.emit('audioOff');
};

LocalMedia.prototype.unmute = function () {
	this._setAudioEnabled(true);
	this.emit('audioOn');
};

// Video controls
LocalMedia.prototype.pauseVideo = function () {
	this._videoEnabled(false);
	this.emit('videoOff');
};
LocalMedia.prototype.resumeVideo = function () {
	this._videoEnabled(true);
	this.emit('videoOn');
};

// Combined controls
LocalMedia.prototype.pause = function () {
	this.mute();
	this.pauseVideo();
};
LocalMedia.prototype.resume = function () {
	this.unmute();
	this.resumeVideo();
};

// Internal methods for enabling/disabling audio/video
LocalMedia.prototype._setAudioEnabled = function (bool) {
	this._audioEnabled = bool;

	this.localStreams.forEach(function (stream) {
		stream.getAudioTracks().forEach(function (track) {
			track.enabled = !!bool;
		});
	});
};
LocalMedia.prototype._videoEnabled = function (bool) {
	this.localStreams.forEach(function (stream) {
		stream.getVideoTracks().forEach(function (track) {
			track.enabled = !!bool;
		});
	});
};

// check if all audio streams are enabled
LocalMedia.prototype.isAudioEnabled = function () {
	var enabled = true;
	var hasAudioTracks = false;
	this.localStreams.forEach(function (stream) {
		var audioTracks = stream.getAudioTracks();
		if (audioTracks.length > 0) {
			hasAudioTracks = true;
			audioTracks.forEach(function (track) {
				enabled = enabled && track.enabled;
			});
		}
	});

	// If no audioTracks were found, that means there is no microphone device.
	// In that case, isAudioEnabled should return false.
	if (!hasAudioTracks) {
		return false;
	}

	return enabled;
};

// check if all video streams are enabled
LocalMedia.prototype.isVideoEnabled = function () {
	var enabled = true;
	var hasVideoTracks = false;
	this.localStreams.forEach(function (stream) {
		var videoTracks = stream.getVideoTracks();
		if (videoTracks.length > 0) {
			hasVideoTracks = true;
			videoTracks.forEach(function (track) {
				enabled = enabled && track.enabled;
			});
		}
	});

	// If no videoTracks were found, that means there is no camera device.
	// In that case, isVideoEnabled should return false.
	if (!hasVideoTracks) {
		return false;
	}

	return enabled;
};

LocalMedia.prototype._removeStream = function (stream) {
	var idx = this.localStreams.indexOf(stream);
	if (idx > -1) {
		this.localStreams.splice(idx, 1);
		this._stopAudioMonitor(this._audioMonitorStreams[idx]);
		this._audioMonitorStreams.splice(idx, 1);
		this.emit('localStreamStopped', stream);
	} else {
		idx = this.localScreens.indexOf(stream);
		if (idx > -1) {
			this.localScreens.splice(idx, 1);
			this.emit('localScreenStopped', stream);
		}
	}
};

LocalMedia.prototype._setupAudioMonitor = function (stream, harkOptions) {
	this._log('Setup audio');
	var audio = hark(stream, harkOptions);
	var self = this;
	var timeout;

	audio.on('speaking', function () {
		self._speaking = true;

		if (self._audioEnabled) {
			self.emit('speaking');
		} else {
			self.emit('speakingWhileMuted');
		}
	});

	audio.on('stopped_speaking', function () {
		if (timeout) {
			clearTimeout(timeout);
		}

		timeout = setTimeout(function () {
			self._speaking = false;

			if (self._audioEnabled) {
				self.emit('stoppedSpeaking');
			} else {
				self.emit('stoppedSpeakingWhileMuted');
			}
		}, 1000);
	});

	self.on('audioOn', function() {
		if (self._speaking) {
			self.emit('stoppedSpeakingWhileMuted');
			self.emit('speaking');
		}
	});

	self.on('audioOff', function() {
		if (self._speaking) {
			self.emit('stoppedSpeaking');
			self.emit('speakingWhileMuted');
		}
	});

	audio.on('volume_change', function (volume, threshold) {
		self.emit('volumeChange', volume, threshold);
	});

	this._audioMonitors.push({audio: audio, stream: stream});
};

LocalMedia.prototype._stopAudioMonitor = function (stream) {
	var idx = -1;
	this._audioMonitors.forEach(function (monitors, i) {
		if (monitors.stream === stream) {
			idx = i;
		}
	});

	if (idx > -1) {
		this._audioMonitors[idx].audio.stop();
		this._audioMonitors.splice(idx, 1);
	}
};

// fallback for old .localScreen behaviour
Object.defineProperty(LocalMedia.prototype, 'localScreen', {
	get: function () {
		return this.localScreens.length > 0 ? this.localScreens[0] : null;
	}
});

module.exports = LocalMedia;
