"use strict";

let Hue = require('node-hue-api');
let _ = require('lodash');
let fs = require('fs');
let nconf = require('nconf');
let moment = require('moment');

/**
 * Main class that allows the program to interact with the Philips Hue API, which
 * in turn controls lights within the home.
 */
class LightingController {
  /**
   * Initializes the variables within the lighting controller.
   * @param  {EventEmitter} emitter The emitter that should be used when publishing or consuming events.
   * @param  {Logger} logger The object that should be used to log messages (informational, trace, error, etc).
   */
  init (emitter, logger) {
    var _self = this;
    if (!_self.initialized) {
      _self.initialized = true;
      _self.connectionEstablished = false;
      _self.connectionInProgress = false;
      _self.connectionRetryAttempts = 0;
      _self.emitter = emitter;
      _self.logger = logger;

      // Attempt to load the Hue bridge name.
      nconf.use('file', { file: 'config.json' });
      _self.hueBridgeUsername = nconf.get('hue:bridgeUsername');
    }
  }

  /**
   * Retrieves the username that was generated when the application paired with
   * the Hue bridge for the first time.
   * @return {string} Username that should be used when connecting to the Hue bridge.
   */
  getBridgeUsername() {
    var _self = this;
    return _self.hueBridgeUsername;
  }

  /**
   * Sets the username that should be used when communicating with the Hue bridge.
   * This value will be stored, so that the application only needs to be registered once.
   * @param {string} username Username that was generated when initially connecting to the Hue bridge.
   */
  setBridgeUsername(username) {
    var _self = this;

    // Update the values stored in the config file, so that this is remembered next time around.
    nconf.use('file', { file: 'config.json' });
    nconf.set('hue:bridgeUsername', username);
    nconf.save(function (err) {
      fs.readFile('config.json', function (err, data) {
        console.dir(JSON.parse(data.toString()))
      });
    });

    _self.hueBridgeUsername = username;
  }

  /**
   * Initializes the event handlers for the lighting controls, primarily around connection retry logic.
   */
  configureEvents() {
    var _self = this;
    _self.logger.trace('Configuring lighting-controller events.');

    // Attempt to connect to the Hue bridge.
    _self.emitter.on('bridgeRetry', function(event){
      _self.logger.info("Retry attempt #%s to establish bridge connection.", _self.connectionRetryAttempts);
      _self.setupHueApi();
    });

    // Connection to the Hue bridge timed out.
    _self.emitter.on('bridgeTimeout', function(event){
      _self.logger.info("Retry timed out after %s attempts.", _self.connectionRetryAttempts);
      _self.connectionInProgress = false;
      _self.publishMessage('bridgeTimeout');
    });

    // Hue bridge was not detected on the network.
    _self.emitter.on('errorNoBridge', function(event){
      if(_self.connectionRetryAttempts === 0) {
        _self.publishMessage('errorNoBridge');
      }
      _self.attemptConnection();
    });

    // Hue bridge was detected, but this application is not registered.
    _self.emitter.on('errorNotRegistered', function(event){
      if(_self.connectionRetryAttempts === 0) {
        _self.publishMessage('errorNotRegistered');
      }
      _self.attemptConnection();
    });

    // Successful connection to the Hue bridge.
    _self.emitter.on('bridgeConnected', function(event){
      _self.logger.info("Connection to bridge has been established.");
      _self.publishMessage('bridgeConnected');

      // Update the tracking information.
      _self.connectionEstablished = true;
      _self.connectionRetryAttempts = 0;
    });
  }

  /**
   * Tracks the number of times a connection has been attempted, and triggers the event to try again.
   * Also determines when it is time to give up and trigger the timeout event.
   */
  attemptConnection() {
    var _self = this;

    // Update the tracking information.
    _self.connectionEstablished = false;
    _self.connectionRetryAttempts += 1;

    // If we haven't reached the retry limit, then try again after waiting a few seconds.
    if(_self.connectionRetryAttempts < 10) {
      setTimeout(function() {
        _self.emitter.emit('bridgeRetry');
      }, 6000);
    }
    else {
      _self.emitter.emit('bridgeTimeout');
    }
  }

  /**
   * Emits a message representing a given condition, which is meant to be communicated to the user.
   * @param  {string} eventType The type of event that has occurred.   */
  publishMessage(eventType) {
    var _self = this;
    var message = '';
    switch(eventType) {
      case 'errorNoBridge':
        message = _self.errorNoBridgePublished === true
          ? "Just a minute while I connect to your lighting system."
          : "I'm having trouble locating your Philips Hue bridge. Please check to see if the device is powered on and connected to your network.";
        _self.errorNoBridgePublished = true;
        break;
      case 'errorNotRegistered':
        message = _self.errorNotRegisteredPublished === true
          ? "Just a minute while I connect to your lighting system."
          : "Press the button on your Philips Hue bridge and I'll let you know when I'm connected.";
        _self.errorNotRegisteredPublished = true;
        break;
      case 'bridgeConnected':
        message = "I am connected to your lighting system. How can I help you today?";
        break;
      case 'bridgeTimeout':
        message = "I can't seem to connect to your bridge and am going to take a break. Let me know when you'd like me to try again.";
        break;
      case 'invalidCommand':
        message = "Sorry I didn't understand that. Perhaps you'd like me to turn the lights on or off, or to dim them?";
        break;
      case 'connectionInProgress':
        message = "Just a minute while I connect to your lighting system.";
        break;
      case 'sleepPrompt':
        message = 'Would you like me to turn off the lights in five minutes?';
        break;
      case 'nightPrompt':
        message = 'Would you like me to turn on the lights?';
        break;
      case 'nightConfirmation':
        message = 'Oh, that\'s much better!';
        break;
      case 'invalidRoom':
        message = 'I don\'t recognize that room.';
        break;
    }
    _self.emitter.emit('userMessage', message);
  }

  /**
   * Creates a stub connection, which can be used when there are no Philips Hue bridges available to use.
   */
  setupFakeBridge() {
    var _self = this;
    _self.logger.trace('setting up fake bridge connection.');
    _self.connectionInProgress = true;
    _self.authenticatedApi = Hue.api('192.168.1.8', 'newdeveloper');
    _self.emitter.emit('bridgeConnected');
  }

  /**
   * Creates an actual connection to a Philips Hue bridge, and triggers the necessary events for failure modes.
   */
  setupActualBridge() {
    var _self = this;
    _self.connectionInProgress = true;

    // Detect the Hue bridges within range.
    _self.logger.trace('setting up actual bridge connection.');
    Hue.nupnpSearch()
      .then(function(bridges){
        // Example response:
        // Hue Bridges Found: [{"id":"001788fffe096103","ipaddress":"192.168.2.129","name":"Philips Hue","mac":"00:00:00:00:00"}]
        _self.logger.trace('Hue Bridges Found: %s', JSON.stringify(bridges));

        // Ensure that we found bridges.
        if(bridges.length === 0)
          throw 'Did not detect any Hue bridges.';

        // Just use the first bridge that was discovered.
        // TODO: This should be updated to allow the user to choose the correct Hue bridge.
        var bridge = _.head(bridges);

        // Check to see if our application is already registered with this bridge.
        if(_self.getBridgeUsername()) {
          _self.authenticatedApi = new Hue.HueApi(bridge.ipaddress, _self.getBridgeUsername());
          _self.validateBridgeConnection();
        }
        else {
          // Otherwise, attempt to register the application.
          _self.registerApplication(bridge.ipaddress);
        }
      })
      .fail(function(error){
        // Could not communicate with the bridge.
        _self.logger.error(error);
        _self.emitter.emit('errorNoBridge');
      })
      .done();
  }

  /**
   * Connects to the Hue bridge using the established instance, to retrieve
   * basic configuration information. If the connection succeeds, then the
   * "bridgeConnected" event will be emitted.
   */
  validateBridgeConnection() {
    var _self = this;

    // Validate the connection by accessing basic information.
    _self.authenticatedApi.fullState()
      .then(function(data){
        _self.emitter.emit('bridgeConnected');
      })
      .fail(function(error){
        // Clear out the stored username.
        _self.logger.error(error);
        _self.authenticatedApi = undefined;
        _self.setBridgeUsername(undefined);
        _self.emitter.emit('errorNotRegistered');
      })
      .done();
  }

  /**
   * Establishes a username for the Jibo application on the Hue bridge. This
   * username will be stored for future use, to prevent re-registering.
   * @param  {string} ipAddress The IP address of the Hue bridge.
   */
  registerApplication(ipAddress) {
    var _self = this;
    var tempApi = new Hue.HueApi();

    tempApi.registerUser(ipAddress, 'jibo-philips-hue')
      .then(function(username){
        // Example response:
        // Existing device user found: 51780342fd7746f2fb4e65c30b91d7
        _self.logger.trace('Device user found: %s', username);

        // Store the authenticated API.
        _self.setBridgeUsername(username);
        _self.authenticatedApi = new Hue.HueApi(ipAddress, _self.getBridgeUsername());
        _self.validateBridgeConnection();
      })
      .fail(function(error){
        // User is not registered with the device.
        _self.logger.error(error);
        _self.emitter.emit('errorNotRegistered');
      })
      .done();
  }

  /**
   * Establishes a connection to the Hue bridge, which can be a fake one (to support testing).
   */
  setupHueApi() {
    var _self = this;
    //_self.setupFakeBridge();
    _self.setupActualBridge();
  }

  /**
   * Triggers behavior within the Hue API, based on the provided action.
   * @param  {string} action The type of action to take (turn on lights, turn off lights, etc).
   * @param {object} params Additional options to be used when invoking the action.
   */
  takeAction(action, params) {
    var _self = this;

    // Clear out any pending actions. These are used for advanced interactions (confirmations, etc).
    _self.request = {
      action: action,
      time: params.time,
      room: params.room,
      state: {}
    };

    // If there is not a valid connection, then do not process the command.
    if(!_self.connectionEstablished) {
      // Trigger the retry workflow if it isn't already running.
      if(!_self.connectionInProgress) {
        _self.logger.trace('Attempting connection to the Hue bridge.')
        _self.connectionRetryAttempts = 0;
        _self.setupHueApi();
      }
      else {
        _self.publishMessage('connectionInProgress');
      }
      return;
    }

    // Call the appropriate method, based on the incoming request.
    _self.logger.info('Received request for action: %s.', action);
    switch(action)
    {
      case 'on':
        _self.turnOnLights();
        break;
      case 'off':
        _self.turnOffLights();
        break;
      case 'dim':
        _self.dimLights();
        break;
      case 'night':
        _self.nighttimeBehavior();
        break;
      case 'sleep':
        _self.bedtimeBehavior();
        break;
      case 'connect':
        _self.setupHueApi();
        break;
      default:
        _self.publishMessage('invalidCommand');
        break;
    }
  }

  /**
   * Confirms an action that is already in progress, triggering the next steps in the process.
   */
  confirmAction() {
    var _self = this;

    // Call the appropriate method, based on the incoming request.
    _self.logger.info('Confirming action: %s.', _self.request.pendingAction);
    switch(_self.request.pendingAction)
    {
      case 'night':
        // Turn on all of the lights and provide a confirmation message.
        _self.turnOnLights();
        _self.publishMessage('nightConfirmation');
        break;
      case 'sleep':
        // Turn off all of the lights in five minutes.
        _self.request.time = moment().add(5, 'minutes');
        _self.turnOffLights();
        break;
      default:
        _self.publishMessage('invalidCommand');
        break;
    }
  }

  /**
   * Clears any pending action information.
   */
  cancelAction() {
    var _self = this;

    // Cancel the request.
    _self.logger.trace('Cancelling request of type "%s"', _self.request.pendingAction);
    _self.request = {};

    // Send an acknowledgment back to the user, to let them know that a change is coming.
    _self.emitter.emit('acknowledgeRequest');
  }

  /**
   * Uses the Hue API to turn off all lights within range.
   */
  turnOffLights() {
    var _self = this;
    _self.request.state = Hue.lightState.create().off();

    _self.logger.trace('Turning off the lights');
    _self.changeLightsState();
  }

  /**
   * Uses the Hue API to turn on all lights within range.
   */
  turnOnLights() {
    var _self = this;
    _self.request.state = Hue.lightState.create().on().brightness(100);

    _self.logger.trace('Turning on the lights');
    _self.changeLightsState();
  }

  /**
   * Uses the Hue API to dim all lights within range. This is essentially changing the brightness of
   * each light to a mid-range value.
   */
  dimLights() {
    var _self = this;
    _self.request.state = Hue.lightState.create().on().brightness(30); // Available range is 0 - 100.

    _self.logger.trace('Dimming the lights');
    _self.changeLightsState();
  }

  /**
   * Triggers the nighttime use case, with Jibo confirming that the user would like to
   * turn off all lights in the home.
   */
  nighttimeBehavior() {
    var _self = this;
    _self.logger.trace('Invoking nighttime behavior.');

    // If this action is not already pending, then kick off the interaction.
    if(_self.request.pendingAction != 'night') {
      // Ask if they want the lights turned on.
      _self.publishMessage('nightPrompt');

      // Mark this as a pending action.
      _self.request.pendingAction = 'night';
    }
  }

  /**
   * Triggers the bedtime use case, with Jibo confirming that the user would like to
   * turn off all lights in the home in 5 minutes.
   */
  bedtimeBehavior() {
    var _self = this;
    _self.logger.trace('Invoking bedtime behavior.');

    // If this action is not already pending, then kick off the interaction.
    if(_self.request.pendingAction != 'sleep') {
      // Ask if they want the lights turned off.
      _self.publishMessage('sleepPrompt');

      // Mark this as a pending action.
      _self.request.pendingAction = 'sleep';
    }
  }

  /**
   * If all of the lights have been processed, then this will publish a notification message for the main application.
   * @param  {integer} lightsProcessed Total number of lights that have already been processed.
   * @param  {integer} totalLights Number of lights that require processing.
   */
  updateLightsStatusCheck(lightsProcessed, totalLights) {
    var _self = this;

    if(lightsProcessed === totalLights) {
      // Determine which action was taken (on/off/dim)
      if(_self.request && _self.request.action)
      {
        // Parse the human-readable action.
        var action = _self.request.action;
        if(action != 'on' && action != 'off' && action != 'dim') {
          // Determine the inferred action, if necessary.
          if(action === 'night') action = 'on';
          if(action === 'sleep') action = 'off';
        }

        // Emit the room-specific message.
        if(_self.request.room) {
          if(action === 'dim') {
            _self.emitter.emit('userMessage', "I've dimmed the lights in the " + _self.request.room);
          }
          // on/off
          else {
            _self.emitter.emit('userMessage', "I've turned " + action + " the lights in the " + _self.request.room);
          }
        }
        // Emit the schedule-specific message.
        else if(_self.request.schedule && _self.request.schedule.localtime) {
          var displayTime = moment(_self.request.schedule.localtime).format('h:mma');
          if(action === 'dim') {
            _self.emitter.emit('userMessage', "Certainly, I'll dim them at " + displayTime);
          }
          // on/off
          else {
            _self.emitter.emit('userMessage', "Certainly, I'll turn them " + action + " at " + displayTime);
          }
        }
      }
      // Also notify with a message if an action was scheduled for the future.
      else if(_self.request.time) {
        var message = "Certainly, I'll turn them <on/off> at <5:00 PM>";
        _self.emitter.emit('userMessage', message);
      }

      // Notify the general completion message.
      _self.logger.trace('Processed all %s light(s), publishing "acknowledgeRequest" notification message.', lightsProcessed);
      _self.emitter.emit('acknowledgeRequest');
    }
  }

  /**
   * Updates each of the lights matching the filter (if supplied), using the provided
   * update action.
  */
  updateLights() {
    var _self = this;

    // Access the connected lights.
    _self.authenticatedApi.lights()
      .then(function(result){
        // Track the number of lights processed, so that we know when we are done.
        var totalLights = _.size(result.lights);
        var lightsProcessed = 0;

        // Loop through each light that was detected.
        _.forEach(result.lights, function(light){
          // Leave this light alone if it is not in the specified room (if a room filter was supplied).
          if(_self.request.filteredLightIds && _.some(_self.request.filteredLightIds, light.id) === '') {
            _self.logger.info('skipping light #%s because it is not in the %s.', light.id, _self.request.room);

            // Notify if we have processed all of the lights.
            ++lightsProcessed;
            _self.updateLightsStatusCheck(lightsProcessed, totalLights);
            return;
          }

          // If a schedule was provided, then apply the changes using it.
          if(_self.request.schedule) {
            // Set the bulb information and setup the schedule.
            _self.request.schedule.command.address = '/api/' + _self.hueBridgeUsername + '/lights/' + light.id + '/state';

            _self.logger.info("Changing state of light #%s to %s at %s.", light.id, JSON.stringify(_self.request.state._values), _self.request.schedule.time);
            _self.authenticatedApi.scheduleEvent(_self.request.schedule)
              .then(function(result){
                _self.logger.info('Attempted to schedule change for light #%s with result of "%s"', light.id, JSON.stringify(result, null, 2));
              })
              .fail(function(error){
                _self.logger.error(error);
              })
              .done(function(data){
                // Notify if we have processed all of the lights.
                ++lightsProcessed;
                _self.updateLightsStatusCheck(lightsProcessed, totalLights);
              });
          }
          // Otherwise, make the change immediately.
          else {
            _self.logger.info("Changing state of light #%s to %s.", light.id, JSON.stringify(_self.request.state._values));
            _self.authenticatedApi.setLightState(light.id, _self.request.state)
              .then(function(result){
                _self.logger.info('Attempted to change state of light #%s with result of "%s"', light.id, JSON.stringify(result, null, 2));
              })
              .fail(function(error){
                _self.logger.error(error);
              })
              .done(function(data){
                // Notify if we have processed all of the lights.
                ++lightsProcessed;
                _self.updateLightsStatusCheck(lightsProcessed, totalLights);
              });
          }
        })
      })
      .fail(function(error){
        _self.logger.error(error);
      });
  }

  /**
   * Modifies the state of all lights that are accessible to the authenticated Hue bridge.
   * The light state object contains information about the change (brightness, on/off, etc.).
   */
  changeLightsState() {
    var _self = this;

    // Create a schedule that represents the users request, if one was provided.
    if(_self.request.time) {
      var time = moment(_self.request.time, "hh:mmA");
      _self.request.schedule = {
        'name': 'Jibo Schedule',
        'description': 'This schedule was created by the jibo-philips-hue application.',
        'time': time.format('YYYY-MM-DDTHH:mm:ss'),
        'localtime': time.format('YYYY-MM-DDTHH:mm:ss'),
        'command': {
          'method' : 'PUT',
          'body'   : _self.request.state._values
        }
      };
    }

    // If a room filter was provided, then identify all lights that should be altered.
    if(_self.request.room) {
      // This array will restrict the lights being altered.
      _self.request.filteredLightIds = [];

      // Get information from light groups.
      _self.authenticatedApi.groups()
        .then(function(groups){
          // Capture the results of this API invocation.
          _self.logger.trace('Located %s light group(s). Details: %s.', _.size(groups), JSON.stringify(groups));

          // Locate the group that matches the specified room.
          var group = _.find(groups, function(g) { return _.toLower(g.name) == _.toLower(_self.request.room); })
          if(group) {
            _self.logger.trace('Found a group that matched requested room. Details: %s.', JSON.stringify(group));

            // Locate the lights in the matching group.
            _self.authenticatedApi.getGroup(group.id)
              .then(function(groupDetails){
                // Use the lights in this room as our filter.
                _self.request.filteredLightIds = groupDetails.lights;
                _self.updateLights();
              })
              .fail(function(error){
                _self.logger.error(error);
              })
              .done();
          }
          else {
            _self.logger.warn('No matching groups were found for room "%s".', _self.request.room);
            _self.publishMessage('invalidRoom');
          }
        })
        .fail(function(error){
          _self.logger.error(error);
        })
        .done();
    }
    else {
      _self.updateLights();
    }
  }
}

module.exports = LightingController;
