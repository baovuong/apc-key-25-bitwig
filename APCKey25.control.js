// Controller for APC Key 25
// Copyright (C) 2014 Osaka Red LLC

loadAPI(1);

host.defineController("Akai", "APC Key 25", "1.0", "65176610-873b-11e4-b4a9-0800200c9a66");
host.defineMidiPorts(1, 0);
host.addDeviceNameBasedDiscoveryPair(["APC Key 25"], ["APC Key 25"]);
host.addDeviceNameBasedDiscoveryPair(["APC Key 25 MIDI 1"], ["APC Key 25 MIDI 1"]);

// Midi notes that are used to change behavior, launch clips, etc.
var control_note =
{
   record :         93,
   play_pause :     91,
   shift :          98,
   clip_stop :      82,
   solo :           83,
   rec_arm :        84,
   mute :           85,
   select :         86,
   stop_all_clips : 81,
   up :             64,
   down :           65,
   left :           66,
   right :          67,
   volume :         68,
   pan :            69,
   send :           70,
   device :         71

   // Grid
   // 32 33 34 ...
   // 24
   // 16
   // 8
   // 0
}

// Just the dimensions of the grid
var grid_width = 8;
var grid_height = 5;
var grid_depth = 1; // number of sends

// An array that maps clip indices to appropriate note values track, scene
var grid_values = [];
for (track = 0; track < grid_width; ++track)
{
   clips = grid_values[track] = []
   for (scene = 0; scene < grid_height; ++scene)
   {
      clips[scene] = (grid_height - 1 - scene) * grid_width + track;
   }
}

// Midi control change messages from the 8 knobs
var lowest_cc = 48;
var highest_cc = 55;

// Note velocities to use in responses to trigger the grid notes
var grid_button_mode =
{
   off :            0,
   green :          1,
   blinking_green : 2,
   red :            3,
   blinking_red :   4,
   amber :          5,
   blinking_amber : 6
}

var track_button_mode =
{
   off :            0,
   red :            1,
   blinking_red :   2
}

var scene_button_mode =
{
   off :            0,
   green :          1,
   blinking_green : 2
}

// If shift is being held
var shift_on = false;
// Which function the knobs currently play
var knob_mode = control_note.device;
// What the present function of the track buttons is
var track_mode = control_note.clip_stop;
// The grid of clips with their states and listener functions, corresponding to the grid on the controller
var grid = [];
// Which track is currently selected
var selected_track_index = 0;
// Represents the different arrow keys and if they are active or not
var arrows = [];
// Whether it's possible to scroll each way or not
var can_scroll_sends_up = false; // might not use
var can_scroll_sends_down = false;

// Some global Bitwig objects
var main_track_bank;

// As described to me by ThomasHelzle
var bitwig_clip_state =
{
   stopped :   0,
   playing :   1,
   recording : 2
}

// Initializes a clip
function initializeClip(clip, scene_index, track_index)
{
   // Clip attributes
   clip.has_content = false;
   // Which state the clip is in
   clip.state = bitwig_clip_state.stopped;
   // What this is queued for depends on the state, above
   clip.queued = false;
   clip.button_note_value = grid_values[track_index][scene_index]

   clip.display = function()
   {
      if (clip.queued)
      {
         switch (clip.state)
         {
            case bitwig_clip_state.stopped:
               if (clip.has_content) sendMidi(144, clip.button_note_value, grid_button_mode.blinking_amber);
               else clip.clear();
               break;
            case bitwig_clip_state.playing:
               sendMidi(144, clip.button_note_value, grid_button_mode.blinking_green);
               break;
            case bitwig_clip_state.recording:
               sendMidi(144, clip.button_note_value, grid_button_mode.blinking_red);
               break;
         }
      }
      else
      {
         switch (clip.state)
         {
            case bitwig_clip_state.stopped:
               if (clip.has_content) sendMidi(144, clip.button_note_value, grid_button_mode.amber);
               else clip.clear();
               break;
            case bitwig_clip_state.playing:
               sendMidi(144, clip.button_note_value, grid_button_mode.green);
               break;
            case bitwig_clip_state.recording:
               sendMidi(144, clip.button_note_value, grid_button_mode.red);
               break;
         }
      }
   }

   clip.clear = function()
   {
      sendMidi(144, clip.button_note_value, grid_button_mode.off);
   }
}

// Initializes a track
function initializeTrack(track, track_index)
{
   track.clips = [];

   // Track attributes
   track.muted = false;
   track.soloed = false;
   track.armed = false;
   track.exists = false;
   track.matrix_stopped = true;
   track.matrix_queued_for_stop = false;
   track.selected = false;
   track.index = track_index;

   // Callbacks for track changes
   // I can probably greatly reduce the lines of code through metaprogramming
   // but I like how clear it is this way
   track.mute_callback = function(muted)
   {
      track.muted = muted
      track.display();
   }

   track.solo_callback = function(soloed)
   {
      track.soloed = soloed;
      track.display();
   }

   track.armed_callback = function(armed)
   {
      track.armed = armed;
      track.display();
   }

   track.exists_callback = function(exists)
   {
      track.exists = exists;
      track.display();
   }

   track.selected_callback = function(selected)
   {
      if (selected)
      {
         selected_track_index = track.index;
      }
      track.selected = selected;
      track.display();
   }

   track.matrix_stopped_callback = function(matrix_stopped)
   {
      track.matrix_stopped = matrix_stopped;
      track.display();
   }

   track.matrix_queued_for_stop_callback = function(matrix_queued_for_stop)
   {
      track.matrix_queued_for_stop = matrix_queued_for_stop;
      track.display();
   }

   // Callbacks to be called by Bitwig but also to be called when putting it back into clip mode
   // (If I ever implement other modes not seen in the Ableton script, wouldn't that be cool?)
   track.has_content_callback = function(scene, has_content)
   {
      clip = track.clips[scene];
      clip.has_content = has_content;
      clip.display();
   }

   track.playing_state_callback = function(scene, state, queued)
   {
      clip = track.clips[scene];
      clip.state = state;
      clip.queued = queued;
      clip.display();
   }

   track.display = function()
   {
      // In shift mode, the track buttons go into a different function
      if (shift_on) return;
      // Duh, don't draw anything if the track doesn't even exist
      if (!track.exists)
      {
         track.clear();
         return;
      }
      switch (track_mode)
      {
         case control_note.clip_stop:
            color = track_button_mode.red;
            if (track.matrix_queued_for_stop)
            {
               color = track_button_mode.blinking_red;
            }
            else if (track.matrix_stopped)
            {
               color = track_button_mode.off;
            }
            sendMidi(144, control_note.up + track.index, color);
            break;
         case control_note.solo:
            sendMidi(144, control_note.up + track.index, track.soloed ? track_button_mode.red : track_button_mode.off);
            break;
         case control_note.rec_arm:
            sendMidi(144, control_note.up + track.index, track.armed ? track_button_mode.red : track_button_mode.off);
            break;
         case control_note.mute:
            // In Ableton, this works differently (lights on for NOT muted) but that seems wrong to me
            sendMidi(144, control_note.up + track.index, track.muted ? track_button_mode.red : track_button_mode.off);
            break;
         case control_note.select:
            sendMidi(144, control_note.up + track.index, track.selected ? track_button_mode.red : track_button_mode.off);
            break;
      }
   }

   track.clear = function()
   {
      sendMidi(144, control_note.up + track.index, track_button_mode.off);
   }

   // Register the track callbacks
   track_object = main_track_bank.getTrack(track_index);
   track_object.getMute().addValueObserver(track.mute_callback);
   track_object.getSolo().addValueObserver(track.solo_callback);
   track_object.getArm().addValueObserver(track.armed_callback);
   track_object.exists().addValueObserver(track.exists_callback);
   track_object.addIsSelectedObserver(track.selected_callback);
   track_object.getIsMatrixStopped().addValueObserver(track.matrix_stopped_callback);
   track_object.getIsMatrixQueuedForStop().addValueObserver(track.matrix_queued_for_stop_callback);
   
   for (scene_index = 0; scene_index < grid_height; ++scene_index)
   {
      clip = {}
      initializeClip(clip, scene_index, track_index);
      track.clips[scene_index] = clip;
   }

   // And the callbacks that pertain to clips
   var clip_launcher = track_object.getClipLauncherSlots();
   clip_launcher.addHasContentObserver(track.has_content_callback);
   clip_launcher.addPlaybackStateObserver(track.playing_state_callback);
}

// Initializes the grid
function initializeGrid()
{
   // In case this somehow gets called multiple times
   grid = [];

   for (track_index = 0; track_index < grid_width; ++track_index)
   {
      track = grid[track_index] = {};
      initializeTrack(track, track_index);
   }
}

function initializeArrow(arrow)
{
   arrow.can_scroll = false;

   arrow.can_scroll_callback = function(can_scroll)
   {
      arrow.can_scroll = can_scroll;
      arrow.display();
   }

   arrow.display = function()
   {
      if (!shift_on) return;
      sendMidi(144, arrow.button_note_value, arrow.can_scroll ? track_button_mode.red : track_button_mode.off);
   }

   arrow.clear = function()
   {
      if (!shift_on) return;
      sendMidi(144, arrow.button_note_value, track_button_mode.off);
   }
}

// Initializes the arrow objects
function initializeArrows()
{
   arrows = [];

   up = arrows[0] = {};
   up.button_note_value = control_note.up;

   down = arrows[1] = {};
   down.button_note_value = control_note.down;

   left = arrows[2] = {};
   left.button_note_value = control_note.left;

   right = arrows[3] = {};
   right.button_note_value = control_note.right;

   for (i = 0; i < 4; ++i)
   {
      arrow = arrows[i];
      initializeArrow(arrow);
   }

   main_track_bank.addCanScrollScenesUpObserver(up.can_scroll_callback);
   main_track_bank.addCanScrollScenesDownObserver(down.can_scroll_callback);
   main_track_bank.addCanScrollTracksUpObserver(left.can_scroll_callback);
   main_track_bank.addCanScrollTracksDownObserver(right.can_scroll_callback);

   for (i = 0; i < 4; ++i)
   {
      arrow = arrows[i];
   }
}

function displayGrid(skip_clips)
{
   for (track_index = 0; track_index < grid_width; ++track_index)
   {
      track = grid[track_index];
      track.display();
      if (!skip_clips)
      {
         for (scene_index = 0; scene_index < grid_height; ++scene_index)
         {
            clip = grid[track_index].clips[scene_index];
            clip.display();
         }
      }
   }
}

function clearGrid(skip_clips)
{
   for (track_index = 0; track_index < grid_width; ++track_index)
   {
      track = grid[track_index];
      track.clear();
      if (!skip_clips)
      {
         for (scene_index = 0; scene_index < grid_height; ++scene_index)
         {
            clip = grid[track_index].clips[scene_index];
            clip.display();
         }
      }
   }
}

function displayArrows()
{
   for (i = 0; i < 4; ++i)
   {
      arrows[i].display();
   }
}

function clearArrows()
{
   for (i = 0; i < 4; ++i)
   {
      arrows[i].clear();
   }
}

// This will only stop the clips found in main_track_bank. Is that the right behavior?
function stopAllClips()
{
   main_track_bank.getClipLauncherScenes().stop();
}

function onCanScrollSendsUp(can_scroll)
{
   printMidi(1, 3, can_scroll);
   can_scroll_sends_up = can_scroll;
}

function onCanScrollSendsDown(can_scroll)
{
   printMidi(1, 2, can_scroll);
   can_scroll_sends_down = can_scroll;
}

function init()
{
   host.getMidiInPort(0).setMidiCallback(onMidi);

   // Make sure to initialize the globals before initializing the grid and callbacks
   main_track_bank = host.createMainTrackBank(grid_width, grid_depth, grid_height);

   // Some global callbacks
   main_track_bank.addCanScrollSendsUpObserver(onCanScrollSendsUp);
   main_track_bank.addCanScrollSendsDownObserver(onCanScrollSendsDown);

   generic = host.getMidiInPort(0).createNoteInput("Akai Key 25", "?1????");
   generic.setShouldConsumeEvents(false);

   transport = host.createTransportSection();

   initializeArrows();
   initializeGrid();
   displayGrid(false);
}

// Light up the mode lights as appropriate for shift mode
function shiftPressed()
{
   shift_on = true;
   clearGrid(true);
   displayArrows();
   sendMidi(144, knob_mode, track_button_mode.red);
   sendMidi(144, track_mode, scene_button_mode.green);
}

// Leaving shift mode, turn off any lights it turned on
function shiftReleased()
{
   clearArrows();
   shift_on = false;
   sendMidi(144, knob_mode, track_button_mode.off);
   sendMidi(144, track_mode, scene_button_mode.off);
   displayGrid(true);
}

// Change the track button mode and, if in shift mode, switch which button is lighted
function changeTrackButtonMode(mode)
{
   // Do nothing if the note is out of range
   if (mode < control_note.clip_stop || mode > control_note.select) return;
   // Turn off light 
   sendMidi(144, track_mode, scene_button_mode.off);
   track_mode = mode;
   // Turn the right mode back on
   sendMidi(144, track_mode, scene_button_mode.green);
}

// Like the above function but for knob modes
function changeKnobControlMode(mode)
{
   if (mode < control_note.volume || mode > control_note.device) return;
   changed = knob_mode != mode;
   if (changed) sendMidi(144, knob_mode, track_button_mode.off);
   // Iterate the send since selecting send multiple times in a row iterates sends
   if (mode == control_note.send)
   {
      if (changed)
      {
         // Somehow go back to first send
      }
      else
      {
         // Check if we can even scroll up first!
         printMidi(0, 0, 0);
         main_track_bank.scrollSendsDown();
         // Somehow reset if we're past the end
      }
   }
   knob_mode = mode;
   if (changed) sendMidi(144, knob_mode, track_button_mode.red);
}

function onMidi(status, data1, data2)
{
   // printMidi(status, data1, data2);

   // We only care about what happens on channel 0 here since that's where all the interesting stuff is
   if (MIDIChannel(status) != 0) return;

   if (isNoteOn(status))
   {
      if (shift_on)
      {
         switch (data1)
         {
            case control_note.up:
               main_track_bank.scrollScenesUp();
               break;
            case control_note.down:
               main_track_bank.scrollScenesDown();
               break;
            case control_note.left:
               main_track_bank.scrollTracksUp();
               break;
            case control_note.right:
               main_track_bank.scrollTracksDown();
               break;
            // Functionality not in the manual that this script adds:
            // shift+stop_all_clips does return to arrangement
            case control_note.stop_all_clips:
               main_track_bank.getClipLauncherScenes().returnToArrangement();
               break;
            default:
               if (data1 >= control_note.clip_stop && data1 <= control_note.select)
               {
                  changeTrackButtonMode(data1);
               }
               else if (data1 >= control_note.volume && data1 <= control_note.device)
               {
                  changeKnobControlMode(data1);
               }
               break;
         }
      }
      else
      {
         switch (data1)
         {
            case control_note.play_pause:
               transport.togglePlay();
               break;
            case control_note.record:
               transport.record();
               break;
            case control_note.shift:
               shiftPressed();
               break;
            case control_note.stop_all_clips:
               stopAllClips();
               break;
            default:
               // From the grid
               if (data1 >= 0 && data1 < 40)
               {
                  track_index = data1 % grid_width;
                  scene_index = grid_height - 1 - Math.floor(data1 / grid_width);
                  main_track_bank.getTrack(track_index).getClipLauncherSlots().launch(scene_index);
               }
               else if (data1 >= control_note.up && data1 <= control_note.device)
               {
                  track_index = data1 - control_note.up;
                  switch (track_mode)
                  {
                     case control_note.clip_stop:
                        main_track_bank.getTrack(track_index).stop();
                        break;
                     case control_note.solo:
                        main_track_bank.getTrack(track_index).getSolo().toggle();
                        break;
                     case control_note.rec_arm:
                        main_track_bank.getTrack(track_index).getArm().toggle();
                        break;
                     case control_note.mute:
                        main_track_bank.getTrack(track_index).getMute().toggle();
                        break;
                     case control_note.select:
                        main_track_bank.getTrack(track_index).select();
                  }
               }
               else if (data1 >= control_note.clip_stop && data1 <= control_note.select)
               {
                  scene_index = data1 - control_note.clip_stop;
                  main_track_bank.getClipLauncherScenes().launch(scene_index);
               }
               break;
         }
      }
   }
   else if (isNoteOff(status))
   {
      switch (data1)
      {
         case control_note.shift:
            shiftReleased();
            break;
      }
   }
   else if (isChannelController(status))
   {
      // Make sure it's in the range. Don't see why it wouldn't be
      if (data1 < lowest_cc || data1 > highest_cc) return;
      track_index = data1 - lowest_cc;
      track = main_track_bank.getTrack(track_index);

      // Functionality depends on which mode we're in
      switch (knob_mode)
      {
         case control_note.volume:
            track.getVolume().set(data2, 128);
            break;
         case control_note.pan:
            track.getPan().set(data2, 128);
            break;
         case control_note.send:
            // It's not certain that this even exists so null check
            send = track.getSend(0);
            if (send) send.set(data2, 128);
            break;
         case control_note.device:
            main_track_bank.getTrack(selected_track_index).getPrimaryDevice().getParameter(track_index).set(data2, 128);
            break;
      }
   }
}

function exit()
{
   clearGrid(false);
}
