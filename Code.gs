/**
 * Code.gs — Apps Script backend for AP Cybersecurity lab submissions.
 *
 * SETUP
 * 1. Create (or open) a Google Sheet that will hold submissions.
 * 2. Extensions -> Apps Script. Delete any starter code, paste this file in.
 * 3. Project Settings (gear icon) -> Script Properties -> Add property:
 *      Property: SUBMISSION_TOKEN
 *      Value:    (the token shared with the Cloudflare Worker proxy)
 * 4. Deploy -> New deployment -> type "Web app".
 *      Execute as:      Me
 *      Who has access:  Anyone
 *    Click Deploy, authorize when prompted, then copy the "Web app URL"
 *    (it ends in /exec).
 * 5. That /exec URL and the SUBMISSION_TOKEN value both go into the
 *    Cloudflare Worker's secrets (`wrangler secret put`) — NOT into any
 *    lab's client-side CONFIG. Labs call the Worker; the Worker calls this.
 *
 * Every lab in the library can point at this same deployed URL —
 * submissions are separated by assignmentId in the sheet, not by a
 * separate script per lab.
 *
 * SERVER-SIDE GRADING
 * Assignments listed in ANSWER_KEYS are graded here, not by the client:
 * the client sends raw selections (id + chosen value), and this script
 * compares them against the key. Assignments not in ANSWER_KEYS fall back
 * to trusting the client-reported score (legacy labs not yet migrated).
 */

var SHEET_NAME = 'Submissions';
var SCREENSHOT_FOLDER_NAME = 'Cyber Lab Submissions';

var ANSWER_KEYS = {
  'mail-triage-social-engineering': {
    questions: {
      1: 'keep',
      2: 'phish',
      3: 'keep',
      4: 'bec',
      5: 'impersonation',
      6: 'keep',
      7: 'phish',
      8: 'keep'
    }
  },
  'vishing-call-triage': {
    questions: {
      1: 'vishing',
      2: 'genuine',
      3: 'vishing',
      4: 'vishing',
      5: 'genuine',
      6: 'vishing'
    }
  },
  'smishing-text-triage': {
    questions: {
      1: 'safe',
      2: 'smishing',
      3: 'safe',
      4: 'smishing',
      5: 'safe',
      6: 'smishing'
    }
  },
  'url-link-inspector': {
    questions: {
      1: 'trusted',
      2: 'suspicious',
      3: 'trusted',
      4: 'suspicious',
      5: 'trusted',
      6: 'suspicious',
      7: 'suspicious',
      8: 'trusted'
    }
  },
  'fake-login-spotter': {
    questions: {
      url: 'flagged',
      banner: 'flagged',
      logo: 'flagged',
      ssn: 'flagged',
      remember: 'unflagged',
      forgot: 'unflagged',
      footer: 'flagged'
    }
  },
  'mail-safety-center': {
    questions: {
      level: 'safelist',
      report: true,
      attach: true,
      q1: 'b',
      q2: 'b',
      q3: 'b'
    }
  },
  'site-survey-physical-security': {
    questions: {
      'cam-door': 'ipcam',
      'cam-interior': 'ipcam',
      'reader-door': 'smartreader',
      'sign-door': 'sign',
      'desk': 'register',
      q1: 'a',
      q2: 'a',
      q3: 'a',
      q4: 'a'
    }
  },
  'research-wing-access-controls': {
    // Compound tasks (multiple fields ANDed together) are pre-combined by
    // the client into a single JSON-stringified value before it's sent, so
    // they still fit the plain "selected === correctAnswer" model here.
    questions: {
      'staff-access': '[true,true]',
      'visitor-deny': false,
      'interlock': true,
      'mfa': 'badge_pin',
      'alarm': true,
      'schedule': 'business',
      'camera': '[true,true]',
      q1: 'b',
      q2: 'c',
      q3: 'b',
      q4: 'b'
    }
  },
  'store-walkthrough-physical-security': {
    // Every hotspot (real + trap) is a flag-state check; every real one also
    // has a companion "<id>-fix" entry for the fix the student picked.
    questions: {
      'cam-register': 'flagged', 'cam-register-fix': 'add-cam',
      'eas-gate': 'unflagged',
      'propped-door': 'flagged', 'propped-door-fix': 'auto-latch',
      'keyed-lock': 'flagged', 'keyed-lock-fix': 'add-reader',
      'no-lighting': 'flagged', 'no-lighting-fix': 'motion-light',
      'no-alarm-sensor': 'flagged', 'no-alarm-sensor-fix': 'door-sensor',
      'paper-trap': 'unflagged',
      'window': 'flagged', 'window-fix': 'bars',
      'sticky-note': 'flagged', 'sticky-note-fix': 'remove-note',
      'locker-trap': 'unflagged'
    }
  }
};

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var expectedToken = PropertiesService.getScriptProperties().getProperty('SUBMISSION_TOKEN');
    if (expectedToken && data.submissionToken !== expectedToken) {
      return jsonOut({ success: false, error: 'Invalid submission token' });
    }
    if (!data.assignmentId || !data.hackerName) {
      return jsonOut({ success: false, error: 'Missing required fields' });
    }

    var graded = gradeSubmission(data);

    var sheet = getOrCreateSheet();

    var screenshotUrl = '';
    if (data.screenshot) {
      try {
        screenshotUrl = saveScreenshot(data.assignmentId, data.hackerName, data.screenshot);
      } catch (imgErr) {
        screenshotUrl = 'error saving image: ' + imgErr.message;
      }
    }

    sheet.appendRow([
      new Date(),
      data.assignmentId,
      data.hackerName,
      graded.earned,
      graded.total,
      JSON.stringify(graded.tasks),
      JSON.stringify(graded.questions),
      screenshotUrl,
      data.clientTimestamp || ''
    ]);

    return jsonOut({
      success: true,
      docUrl: screenshotUrl || null,
      score: { earned: graded.earned, total: graded.total }
    });
  } catch (err) {
    return jsonOut({ success: false, error: err.message });
  }
}

/**
 * Grades a submission against ANSWER_KEYS when the assignment has one.
 * Falls back to trusting the client-reported score for assignments that
 * haven't been migrated to server-side grading yet.
 */
function gradeSubmission(data) {
  var key = ANSWER_KEYS[data.assignmentId];
  var clientTasks = data.tasks || [];

  if (!key) {
    return {
      earned: (data.score && data.score.earned) || 0,
      total: (data.score && data.score.total) || 0,
      questions: data.questions || [],
      tasks: clientTasks
    };
  }

  var selectedById = {};
  (data.selections || []).forEach(function (s) { selectedById[s.id] = s.selected; });

  var questionIds = Object.keys(key.questions);
  var questionResults = questionIds.map(function (id) {
    // hasOwnProperty, not `|| null` — a genuine `false`/`0` answer (e.g. a
    // toggle a lab expects OFF) must not collapse into "no answer given".
    var chosen = selectedById.hasOwnProperty(id) ? selectedById[id] : null;
    var correctAnswer = key.questions[id];
    return { id: id, selected: chosen, correct: chosen === correctAnswer };
  });
  var questionsEarned = questionResults.filter(function (q) { return q.correct; }).length;
  var allCorrect = questionsEarned === questionIds.length;
  var allClassified = questionIds.every(function (id) { return selectedById.hasOwnProperty(id) && selectedById[id] !== null; });

  // "classified-all" and "all-correct" are fully derivable from the answer
  // key and the selections we just graded, so recompute them rather than
  // trust whatever the client claims. Any other task id (e.g. "opened-all",
  // a read-every-message check we have no server-side signal for) keeps
  // the client's reported value.
  var tasks = clientTasks.map(function (t) {
    if (t.id === 'classified-all') return { id: t.id, label: t.label, passed: allClassified };
    if (t.id === 'all-correct') return { id: t.id, label: t.label, passed: allCorrect };
    return { id: t.id, label: t.label, passed: !!t.passed };
  });
  var tasksEarned = tasks.filter(function (t) { return t.passed; }).length;

  return {
    earned: tasksEarned + questionsEarned,
    total: tasks.length + questionIds.length,
    questions: questionResults,
    tasks: tasks
  };
}

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'Server Timestamp', 'Assignment', 'Hacker Name', 'Score', 'Total',
      'Tasks (JSON)', 'Questions (JSON)', 'Screenshot Link', 'Client Timestamp'
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function saveScreenshot(assignmentId, hackerName, dataUrl) {
  var folder = getOrCreateFolder(SCREENSHOT_FOLDER_NAME);
  var comma = dataUrl.indexOf(',');
  var base64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
  var safeHacker = String(hackerName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  var filename = assignmentId + '_' + safeHacker + '_' + new Date().getTime() + '.png';
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/png', filename);
  var file = folder.createFile(blob);

  // The file is already saved at this point regardless of what happens below -
  // sharing is a separate permission from creating/owning the file. Try
  // domain-restricted sharing first (the right default for student work, and
  // the one most school Workspace domains actually allow), then public
  // link-sharing, and if both are blocked by domain policy, just keep the file
  // private to the owner rather than losing the URL entirely.
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (domainErr) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (anyoneErr) {
      // Sharing is restricted by domain policy either way. The file still
      // exists and is owned by this account - just not link-shareable beyond
      // that. Fall through and return its URL anyway.
    }
  }

  return file.getUrl();
}

function getOrCreateFolder(name) {
  var folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Optional: run this once manually from the Apps Script editor (select
 * "setSubmissionToken" in the function dropdown, click Run) instead of
 * using the Script Properties UI, if you'd rather set the token in code.
 * Replace the placeholder before running, then delete your token from
 * source if you ever share this file.
 */
function setSubmissionToken() {
  PropertiesService.getScriptProperties().setProperty('SUBMISSION_TOKEN', 'REPLACE_WITH_YOUR_TOKEN');
}
