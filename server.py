#!/usr/bin/env python
# -*- coding: utf-8 -*-

from twisted.internet import reactor
from twisted.internet.protocol import Protocol, Factory
from txsockjs.factory import SockJSFactory
import json, uuid

class AudioRoomProtocol(Protocol):
    id = None
    name = None
    room = None
    
    def dataReceived(self, data):
        data = json.loads(data)
        method = getattr(self, "handle_" + data["type"].upper(), None)
        if method is None:
            self.handle_unknown(data)
        else:
            method(data)
    
    def connectionLost(self, reason=None):
        self.handle_LEAVE({})
        del self.factory.clients[self.id]
    
    def write(self, data):
        self.transport.write(json.dumps(data))
    
    def send(self, id, data):
        data["id"] = self.id
        data["name"] = self.name
        if id in self.factory.clients:
            self.factory.clients[id].write(data)
    
    def relay(self, data):
        self.send(data["id"], data)
    handle_CANDIDATE = relay
    handle_ANSWER = relay
    handle_OFFER = relay
    
    def handle_NAME(self, data):
        self.name = data["name"]
        self.write({
            "type": "rooms",
            "rooms": self.factory.rooms.values()
        })
    
    def handle_CREATE(self, data):
        data["id"] = self.factory.genID()
        self.factory.rooms[data["id"]] = {
            "id": data["id"],
            "name": data["name"],
            "clients": {}
        }
        self.handle_JOIN(data)
    
    def handle_JOIN(self, data):
        if self.room is not None:
            return
        if data["id"] not in self.factory.rooms:
            return
        self.room = data["id"]
        self.write({"type":"clients", "id":self.room, "clients": [{"id":id, "name":name} for id, name in self.factory.rooms[self.room]["clients"].items()]})
        self.factory.rooms[self.room]["clients"][self.id] = self.name
    
    def handle_LEAVE(self, data):
        if self.room is None:
            return
        del self.factory.rooms[self.room]["clients"][self.id]
        data["type"] = "left"
        for client in self.factory.rooms[self.room]["clients"].keys():
            self.send(client, data)
        self.room = None
    
    def handle_unknown(self, data):
        print json.dumps(data)

class AudioRoomFactory(Factory):
    protocol = AudioRoomProtocol
    clients = {}
    rooms = {}
    
    def buildProtocol(self, addr):
        p = Factory.buildProtocol(self, addr)
        p.id = self.genID()
        self.clients[p.id] = p
        return p
    
    def genID(self):
        return str(uuid.uuid4())

reactor.listenTCP(8082, SockJSFactory(AudioRoomFactory()))
reactor.run()
