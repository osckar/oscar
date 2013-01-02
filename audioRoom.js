;(function($) {

/** Adapter **/
var AudioContext = AudioContext || webkitAudioContext || mozAudioContext;
var URL = URL || webkitURL;
var getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia).bind(navigator);
var RTCPeerConnection = RTCPeerConnection || webkitRTCPeerConnection || mozRTCPeerConnection || msRTCPeerConnection;
var attachMediaStream = function(element, stream) {
    try {
        element.src = window.URL.createObjectURL(stream);
    } catch(e) {
        try {
            element.mozSrcObject = stream;
            element.play();
        } catch(e){
            console.log("Error setting element src: ", e);
        }
    }
};

/** Global variables **/
var name, room, conn, stream, remotes = {};

/** Handlers **/
function addRemote(id,offer) {
    var remote = {
        id: id,
        conn: null,
        context: null,
        source: null,
        processor: null,
        destination: null,
        data: {} // Passed to triggers for reliable per-client storage
    };
    remote.conn = new RTCPeerConnection($.audioRoom.options.pcConfig);
    remote.conn.onicecandidate = function(e) {
        if (e.candidate) {
            $.audioRoom.send({
                id: id,
                type: "candidate",
                label: event.candidate.sdpMLineIndex,
                candidate: event.candidate.candidate
            });
        }
    };
    remote.conn.onaddstream = gotStream.bind(null, remote);
    remote.conn.addStream(stream);
    if(offer) {
        remote.conn.setRemoteDescription(new RTCSessionDescription(offer));
        remote.conn.createAnswer(function(desc) {
            remote.conn.setLocalDescription(desc);
            $.audioRoom.send({
                id: id,
                type: "answer",
                answer: desc
            });
        });
    } else {
        remote.conn.createOffer(function(desc) {
            remote.conn.setLocalDescription(desc);
            $.audioRoom.send({
                id: id,
                type: "offer",
                offer: desc
            });
        });
    }
    remotes[id] = remote;
}

function gotStream(remote, e) {
    // Add volume detection
    remote.context = new AudioContext();
    remote.source = remote.context.createMediaStreamSource(e.stream);
    remote.processor = remote.context.createScriptProcessor(8192, 1, 0);
    remote.destination = remote.context.createMediaStreamDestination();
    remote.source.connect(remote.processor);
    remote.source.connect(remote.destination);
    remote.processor.connect(remote.destination);
    remote.processor.onaudioprocess = processAudio.bind(null, remote);
    // Fire the trigger
    console.log(remote, e);
    $(window).trigger("audioRoom_stream", [remote.id, remote.data, remote.destination.stream]);
};

function processAudio(remote, e) {
    // Get the buffer
    var input = e.inputBuffer.getChannelData(0),
        len = input.length, 
        total = 0,
        i = 0,
        rms,
        volume;
    console.log(remote);
    while(i < len) total += Math.abs(input[i++]); // Determine total volume
    rms = Math.sqrt(total / len); // Determine RMS volume
    volume = 100 * rms; // Make it a percentage
    $(window).trigger("audioRoom_volume", [remote.id, remote.data, volume]); // Broadcast the value
};

function processMessage(e) {
    console.log("<<< "+e.data);
    data = JSON.parse(e.data);
    switch(data.type) {
        // Listing of rooms upon entering a name, or leaving a room
        case "rooms":
            $(window).trigger("audioRoom_roomList", [data.rooms]);
            break;
        // Room ID & list of clients in a room upon joining or creating
        case "clients":
            room = data.id;
            for(var i = 0; i < data.clients.length; i++) {
                addRemote(data.clients[i].id);
                remotes[data.clients[i].id].data.name = data.clients[i].name;
            }
            var clients = {};
            for(var id in remotes) {
                if(!remotes.hasOwnProperty(id)) continue;
                clients[id] = remotes[id].data;
            }
            $(window).trigger("audioRoom_room", [room, clients]);
            break;
        // Client offer upon joining the room
        case "offer":
            addRemote(data.id, data.offer);
            remotes[data.id].data.name = data.name;
            break;
        // Client answer to our offer
        case "answer":
            remotes[data.id].conn.setRemoteDescription(new RTCSessionDescription(data.answer));
            break;
        // Client candidate
        case "candidate": 
            remotes[data.id].conn.addIceCandidate(new RTCIceCandidate({sdpMLineIndex: data.label, candidate: data.candidate}));
            break;
        // Client left the room
        case "left": 
            $(window).trigger("audioRoom_left", [data.id, remotes[data.id].data]);
            delete remotes[data.id]; // Audio stream will clean up automatically
            break;
    };
};

/** Global Engine **/
$.audioRoom = {
    options: {
        "video": false,
        "pcConfig": {
            "iceServers": [
                {"url": "stun:stun.l.google.com:19302"},
                {"url": "stun:stun1.l.google.com:19302"},
                {"url": "stun:stun2.l.google.com:19302"},
                {"url": "stun:stun3.l.google.com:19302"},
                {"url": "stun:stun4.l.google.com:19302"},
                {"url": "stun:stunserver.org"}
            ]
        }
    },
    
    connect: function(ws, devices) {
        if(conn) return false; // Only connect once
        conn = ws;
        conn.addEventListener("message", processMessage);
        getUserMedia($.extend({audio: true, video: false}, devices), function(s) {
            stream = s;
        }, function(error) {
            console.log("navigator.getUserMedia error: ", error);
        });
        if(name) {
            $.audioRoom.send({
                type: "name",
                name: name
            });
        }
        return true;
    },
    
    name: function(n) {
        if(!n) return name; // Return current name if called without an argument
        if(name) return false; // Don't support renaming - yet
        name = n;
        if(conn) {
            $.audioRoom.send({
                type: "name",
                name: name
            });
        }
        return true;
    },
    
    create: function(name) {
        if(!name) return false; // Need a name for the channel
        if(!conn) return false; // Need a connection to create a room
        if(room) return false; // Can't be in two rooms at once
        room = -1; // Connecting
        $.audioRoom.send({
            type: "create",
            name: name
        });
        return true;
    },
    
    join: function(id) {
        if(!id) return false; // Need an id to join
        if(!conn) return false; // Need a connection to join a room
        if(room) return false; // Can't be in two rooms at once
        room = -1; // Connecting
        $.audioRoom.send({
            id: id,
            type: "join"
        });
        return true;
    },
    
    leave: function() {
        if(!conn) return false; // Need a connection to leave a room
        if(!room || room < 0) return false; // Need to be in a room to leave
        // Close all p2p connections
        for(var key in remotes) {
            if(!remotes.hasOwnProperty(key)) continue;
            remotes[key].conn.close();
        }
        $.audioRoom.send({type: "leave"}); // Tell the server we're leaving the room
        room = null; // Allow joining a new room
        remotes = {}; // Clear peer list
    },
    
    /* To clarify: these mute functions work on the outgoing stream */
    mute: function() {
        if(!stream) return false; // Need a stream to mute
        stream.audioTracks[0].enabled = false;
        return true;
    },
    
    unmute: function() {
        if(!stream) return false; // Need a stream to unmute
        stream.audioTracks[0].enabled = true;
        return true;
    },
    
    toggleMute: function() {
        if(!stream) return false; // Need a stream to (un)mute
        stream.audioTracks[0].enabled = !stream.audioTracks[0].enabled;
        return true;
    },
    
    muted: function() {
        if(!stream) return true; // No stream means no volume for others
        return !stream.audioTracks[0].enabled;
    },
    
    // Helper methods
    attach: attachMediaStream,
    
    send: function(data) {
        if(!conn) return false; // Can't send data on a non-existant connection
        var data = JSON.stringify(data);
        conn.send(data);
        console.log(">>> "+data);
        return true;
    },
    
    // Plugin methods
    methods: {
        init: function(config) {
            this.each(function() {
                // Generate config
                var config = $.extend({}, $.audioRoom.options, config);
                var $this = $(this);
                $this.data("audioRoom",config);
                config.clients = {};
                // Generate elements
                config.elements = {
                    nameForm: $("<form>"),
                    nameHeader: $("<h1>"),
                    nameInput: $("<input>"),
                    nameSubmit: $("<input>"),
                    roomTable: $("<table>"),
                    createRow: $("<tr>"),
                    createCell: $("<td>"),
                    createForm: $("<form>"),
                    createInput: $("<input>"),
                    createSubmit: $("<input>"),
                    clientList: $("<div>"),
                    controlDiv: $("<div>"),
                    inputMute: $("<button>"),
                    outputMute: $("<button>")
                }
                // Set up elements
                config.elements.nameHeader.text("Choose a Nickname");
                config.elements.nameInput.attr("type","text").css("display","block");
                config.elements.nameSubmit.attr("type","submit").val("Log In");
                config.elements.roomTable.hide();
                config.elements.createCell.attr("colSpan","2");
                config.elements.createInput.attr("type","text").css("display","block");
                config.elements.createSubmit.attr("type","submit").val("Create a room");
                config.elements.clientList.hide();
                config.elements.inputMute.text("Mute Microphone");
                config.elements.outputMute.text("Mute Speakers");
                // Build DOM
                config.elements.nameForm.append(config.elements.nameHeader, config.elements.nameInput, config.elements.nameSubmit);
                config.elements.roomTable.append(config.elements.createRow.append(config.elements.createCell.append(config.elements.createForm.append(config.elements.createInput,config.elements.createSubmit))));
                config.elements.clientList.append(config.elements.controlDiv.append(config.elements.inputMute, config.elements.outputMute));
                $this.append(config.elements.nameForm, config.elements.roomTable, config.elements.clientList);
                // Register handlers
                config.elements.nameForm.submit(function() {
                    // Pass form value to global handler and wait for rooms trigger
                    $.audioRoom.name(config.elements.nameInput.val());
                    return false;
                });
                config.elements.createForm.submit(function() {
                    $.audioRoom.create(config.elements.createInput.val());
                    return false;
                });
                config.elements.inputMute.click(function() {
                    $.audioRoom.toggleMute();
                    config.elements.inputMute.text($.audioRoom.muted() ? "Unmute Microphone" : "Mute Microphone");
                });
                config.elements.outputMute.click(function() {
                    config.muted = !config.muted;
                    config.elements.outputMute.text(config.muted ? "Unmute Speakers" : "Mute Speakers");
                    for(var id in config.clients) {
                        if(!config.clients.hasOwnProperty(id)) continue;
                        var client = config.clients[id];
                        client.audio.prop("muted", config.muted);
                    }
                });
                $(window).bind("audioRoom_roomList", function(e, rooms) {
                    config.elements.nameForm.hide();
                    config.elements.roomTable.find("tr:not(:first-child)").remove();
                    for(var i = 0; i < rooms.length; i++) {
                        var room = rooms[i];
                        var clients = [];
                        for(var key in room.clients) {
                            if(!room.clients.hasOwnProperty(key)) continue;
                            clients.push(room.clients[key]);
                        }
                        var name = $("<td>").text(room.name + " (" + clients.length + ")");
                        var clientlist = $("<td>").text(clients.join(", "));
                        var row = $("<tr>").append(name, clientlist).click(function() {
                            $.audioRoom.join(room.id);
                        });
                        config.elements.roomTable.append(row);
                    }
                    config.elements.roomTable.show();
                });
                $(window).bind("audioRoom_room", function(e, room, clients) {
                    config.elements.roomTable.hide();
                    config.elements.clientList.show();
                });
                $(window).bind("audioRoom_stream", function(e, id, client, stream) {
                    client.stream = stream;
                    client.nameHeader = $("<h1>").text(client.name).css("margin","0");
                    client.nameCell = $("<div>").append(client.nameHeader).css("float","left").css("width","39%");
                    client.audio = $(config.video ? "<video>" : "<audio>").attr("autoplay", "autoplay").attr("controls", "controls");
                    client.audioControl = $("<div>");
                    client.volumeBar = $("<div>").css("height", "100%").css("width", "0%");
                    client.audioCell = $("<div>").append(client.audio, client.audioControl).css("float","right").css("width","60%").css("text-align","center");
                    client.row = $("<div>").append(client.nameCell, client.audioCell).data("client",client).css("clear","both");
                    config.elements.clientList.append(client.row);
                    config.clients[id] = client;
                    // Attach audio late in the game
                    $.audioRoom.attach(client.audio[0], client.stream);
                    // Defer JQuery UI code until after adding to DOM
                    var setVolume = function(e, ui) {
                        client.audio[0].volume = ui.value;
                    };
                    client.audioControl.slider({
                        orientation: "horizontal",
                        range: "min",
                        value: 1,
                        min: 0,
                        max: 1,
                        step: 0.05,
                        slide: setVolume,
                        change: setVolume
                    }).find(".ui-slider-range").append(client.volumeBar);
                });
                $(window).bind("audioRoom_volume", function(e, id, client, volume) {
                    volume = Math.floor(1.2 * volume);
                    var bg = config.muted ? "black" : (volume > 100 ? "red" : "green");
                    client.volumeBar.css("width", volume+"%").css("background", bg);
                });
                $(window).bind("audioRoom_left", function(e, id, client) {
                    client.row.remove();
                    delete config.clients[id];
                });
            });
        }
    }
};

/** Plugin **/
$.fn.audioRoom = function(method) {
    // Method calling logic
    if($.audioRoom.methods[method]) {
        return $.audioRoom.methods[method].apply(this, Array.prototype.slice.call(arguments, 1));
    } else if(typeof method === 'object' || !method) {
        return $.audioRoom.methods.init.apply(this, arguments);
    } else {
        $.error('Method ' +  method + ' does not exist on jQuery.audioRoom');
    }
};

})(jQuery);