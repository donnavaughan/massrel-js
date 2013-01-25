define(['helpers', 'poller_queue'], function(helpers, PollerQueue) {

  function Poller(stream, opts) {
    this.stream = stream;
    this._callbacks = [];
    this._enumerators = [];
    this._bound_enum = false;
    this._t = null;
    
    opts = opts || {};
    this.limit = opts.limit || null;
    this.since_id = opts.since_id || null;
    this.start_id = opts.start_id || null;
    this.replies = !!opts.replies;
    this.geo_hint = !!opts.geo_hint;
    this.keywords = opts.keywords || null;
    this.frequency = (opts.frequency || 30) * 1000;
    this.stay_realtime = 'stay_realtime' in opts ? !!opts.stay_realtime : true;
    this.enabled = false;
    this.alive = true;
    this.alive_instance = 0;
    this.consecutive_errors = 0;
  }
  Poller.prototype.poke = function(fn) {
    // this method should not be called externally...
    // it basically restarts the poll loop if it stopped for network errors
    // we call this if a request takes longer than 10sec
    if(!this.alive && this.enabled) {
      this._t = null;
      this.start();
    }
    return this;
  };
  Poller.prototype.batch = function(fn) {
    this._callbacks.push(fn);
    return this;
  };
  Poller.prototype.each = function(fn) {
    this._enumerators.push(fn);
    return this;
  };
  Poller.prototype.start = function() {
    if(this._t) {
      return this;
    }
    this.enabled = true;
    var instance_id = this.alive_instance = this.alive_instance + 1;
    var hail_mary = !!this.stream.hail_mary;
    
    var self = this;
    var sortable_prop = 'entity_id';
    function poll() {
      self.alive = false;

      if(!self.enabled || instance_id !== self.alive_instance) { return; }

      var load_opts = {};
      if(self.stay_realtime) {
        load_opts.since_id = self.since_id;
      }
      else {
        load_opts.from_id = self.since_id;
      }

      self.stream.load(self.params(load_opts), function(statuses) {
        self.alive = true;
        self.consecutive_errors = 0;
        if(hail_mary && statuses && statuses.length > 0) {
          var limit = self.limit || Infinity;

          // only use new statuses
          // use the 
          if(self.newest_timestamp) {
            if(statuses[0][sortable_prop] <= self.newest_timestamp) {
              // if first/newest item in request is equal or older than
              // what the poller knows about, then there are no newer
              // statuses to display
              statuses = [];
            }
            else if(statuses[statuses.length - 1][sortable_prop] > self.newest_timestamp) {
              // if last/oldest item in request is newer than what the poller knows
              // then all statuses are new. we only care about making sure
              // statuses.length <= limit
              if(statuses.length > limit) {
                statuses.splice(self.limit, statuses.length - limit);
              }
            }
            else {
              // the last status the poller knows about is somewhere inside of the
              // of the requested statuses. grab the statuses that are newer than
              // what the poller knows about until there are no more statuses OR
              // we have collecte limit statuses
              var newerStatuses = [];

              for(var i = 0, len = statuses.length; i < len && newerStatuses.length < limit; i++) {
                var status = statuses[i];
                if(status[sortable_prop] > self.newest_timestamp) {
                  newerStatuses.push(status);
                }
                else {
                  break;
                }
              }

              statuses = newerStatuses;
            }
          }
          else if(statuses.length > limit) {
            statuses.splice(self.limit, statuses.length - limit);
          }
        }

        if(statuses && statuses.length > 0) {
          self.since_id = statuses[0].entity_id;
          self.newest_timestamp = statuses[0][sortable_prop];

          if(!self.start_id) { // grab last item ID if it has not been set
            self.start_id = statuses[statuses.length - 1].entity_id;
          }
          
          // invoke all batch handlers on this poller
          for(var i = 0, len = self._callbacks.length; i < len; i++) {
            self._callbacks[i].call(self, statuses); // we might need to pass in a copy of statuses array
          }
          
          // invoke all enumerators on this poller
          helpers.step_through(statuses, self._enumerators, self);
        }
        self._t = setTimeout(poll, helpers.poll_interval(self.frequency));
      }, function() {
        self.consecutive_errors += 1;
        self.poke();
      });

    }
  
    poll();
    
    return this;
  };
  Poller.prototype.stop = function() {
    clearTimeout(this._t);
    this._t = null;
    this.enabled = false;
    return this;
  };
  Poller.prototype.queue = function(fn) {
    var queue = new PollerQueue(this);
    queue.next(fn);
    return this;
  };
  Poller.prototype.more = function(fn, error) {
    //TODO: build in a lock, so multiple "more" calls
    //are called sequentially instead of in parallel

    var self = this
      , fetch = function() {
          self.stream.load(self.params({
            start_id: self.start_id
          }), function(statuses) {
            if(statuses.length > 0) {
              self.start_id = statuses[statuses.length - 1].entity_id;
              if(!self.since_id) {
                self.since_id = statuses[0].entity_id;
              }

            }
            fn.call(self, statuses);
          }, function() {
            // error
            if(typeof(error) === 'function') {
              error();
            }
          });
        };

    fetch();

    return this;
  };
  Poller.prototype.params = function(opts) {
    return helpers.extend({
      limit: this.limit,
      replies: this.replies,
      geo_hint: this.geo_hint,
      keywords: this.keywords
    }, opts || {});
  };

  return Poller;
});
