import { Meteor } from 'meteor/meteor'
import { Tracker } from 'meteor/tracker'
import { ReactiveVar } from 'meteor/reactive-var'

import Planning from './lib/Planning.js'
import RemuPNT from './lib/RemuPNT.js'
import RemuPNC from './lib/RemuPNC.js'

import _ from 'lodash'
import swal from 'sweetalert2'

const NOW = new Date()
const isPNT = new ReactiveVar(false)

Controller = {
	eventsStart: moment(),
	eventsEnd: moment(),

	currentMonth: new ReactiveVar({
		year: NOW.getFullYear(),
		month: NOW.getMonth()
	}, _.isEqual),

	selectedDay: new ReactiveVar(null, _.isEqual),
	currentEvents: new ReactiveVar([], _.isEqual),

	Calendar: null,
  Planning: null,
	Remu: null,

  _stopPlanningCompute: false,
  _isLoading: new ReactiveVar(true),
  _bareme: null,
  _salaire: new ReactiveVar({ AF: {}, TO: {} }),
	_statsRemu: new ReactiveVar({ HC: 0.0, eHS: 0.0, tv: 0.0 }),

	init() {
    this.reparseEventsOfCurrentMonth = _.debounce(this._reparseEventsOfCurrentMonth, 3000, { leading: true, trailing: false })

    this.Calendar = Calendar
    this.Calendar.init()

		this.EventsSubs = null

    // console.time('Config.ready')
		// Tracker.autorun(c => {
		// 	if (Config.ready()) {
    //     console.timeEnd('Config.ready')
		// 		const cmonth = Config.get('currentMonth')
		// 		if (cmonth) {
		// 			this.currentMonth.set(cmonth)
		// 		} else {
    //       const now = moment()
    //       this.currentMonth.set({
    //         year: now.year(),
    //     		month: now.month()
    //       })
    //     }
    //     this.initAutoruns()
		// 	}
		// })
    this.initAutoruns()

    Tracker.autorun(c => {
      if (Events.loaded) {
        const twoYearsAgo = moment().startOf('month').subtract(2, 'years')
        Events.removeFromCacheBefore(twoYearsAgo.valueOf())
        c.stop()
      }
    })

    Tracker.autorun(() => {
      if (Meteor.userId()) {
        console.time('Controller.isPNT')
        Meteor.call('isPNT', (e,r) => {
          if (!e && _.isBoolean(r)) {
            isPNT.set(r)
            console.log('Controller.isPNT', r)
          } else {
            isPNT.set(false)
          }
          console.timeEnd('Controller.isPNT')
        })
      } else {
        isPNT.set(false)
      }
    })
	},

  initAutoruns() {
    Tracker.autorun(() => {
			const currentMonth = this.currentMonth.get()
      this.Calendar.buildCalendarDays(currentMonth)

      Config.set('currentMonth', currentMonth)

      Events.stopSync()

			const cmonth = moment(currentMonth)
			this.eventsStart = cmonth.clone().subtract(1, 'month')
			this.eventsEnd = cmonth.endOf('month').add(1, 'month')

      console.time('Events.loaded & EventsSubs.ready')
			this.EventsSubs = Meteor.subscribe('cloud_events', +this.eventsStart, +this.eventsEnd, Meteor.userId())
		})

    Tracker.autorun(() => {
      if (Events.loaded) {
        console.time('Controller.updateCalendarEventsObserver')
        const currentMonth = this.currentMonth.get()
        const eventsCursor = Events.find({
          userId: Meteor.userId(),
          end: { $gte: +moment(currentMonth).startOf('month').startOf('week') },
          start: { $lte: +moment(currentMonth).endOf('month').endOf('week') }
        }, { sort: [['start', 'asc'], ['end', 'desc']] })

        this.Calendar.observeEvents(eventsCursor)

        console.timeEnd('Controller.updateCalendarEventsObserver')
      }
    })

    Tracker.autorun(() => {
      if (this.EventsSubs.ready() && Events.loaded) {
        console.timeEnd('Events.loaded & EventsSubs.ready : syncing db')
        Events.sync({
          userId: Meteor.userId(),
          end: { $gte: +this.eventsStart },
          start: { $lte: +this.eventsEnd }
        })
      }
    })

		Tracker.autorun(() => {
      if (Events.loaded) {
        const currentMonth = this.currentMonth.get()
        const eventsCursor = Events.find({
					userId: Meteor.userId(),
					end: { $gte: +moment(currentMonth).startOf('month').startOf('week') },
					start: { $lte: +moment(currentMonth).endOf('month').endOf('week') }
				}, { sort: [['start', 'asc'], ['end', 'desc']] })
  			const events = eventsCursor.fetch()

        this.currentEvents.set(events)

        // Transform events
        _.forEach(events, doc => {
      		_.extend(doc, {
      			start: moment(doc.start),
      			end: moment(doc.end)
      		})
      		if (doc.real) {
      			if (doc.real.start) doc.real.start = moment(doc.real.start)
      			if (doc.real.end) doc.real.end = moment(doc.real.end)
      		}
      	})

        console.log('Controller.eventsChanged', events)

        if (!this._stopPlanningCompute) {
          console.time('Controller.calculPlanning')

          Meteor.defer(() => {
            this.Planning = new Planning(events, currentMonth)
            console.timeEnd('Controller.calculPlanning')

            Tracker.autorun(() => {
              const isPNT = this.isPNT()

              // console.log('Controller.isPNT changed or HV100 & HV100AF ready', isPNT)

              if (isPNT) {
                if (HV100AF.ready() && HV100.ready()) {
                  console.time('Controller.calculSalaire')
                  this.Remu = new RemuPNT(this.Planning.groupedEvents(), currentMonth)
                  this._statsRemu.set(this.Remu.stats)
                  Tracker.autorun(() => {
                    if (Config.ready()) {
                      const profil = Config.get('profil')
                      // console.log('Controller.profilChanged', profil)
                      if (_.has(this._bareme, 'AF') && _.has(this._bareme, 'TO')) {
                        this.calculSalaire(this.Remu.stats, profil)
                        console.timeEnd('Controller.calculSalaire')
                      } else {
                        Meteor.call('getPayscale', (e,r) => {
                          if (!e && _.has(r, 'AF') && _.has(r, 'TO')) {
                            this._bareme = r
                            this.calculSalaire(this.Remu.stats, profil)
                            console.timeEnd('Controller.calculSalaire')
                          }
                        })
                      }
                    } else {
                      this._bareme = null
                    }
                  })
                }
              } else if (HV100.ready()) {
                this.Remu = new RemuPNC(this.Planning.groupedEventsThisMonth(), currentMonth)
                this._statsRemu.set(this.Remu.stats)
              }

              // Refresh modal content
              Tracker.nonreactive(() => {
                if (this.selectedDay.get()) {
          				this.setSelectedDay(this.selectedDay.get())
          			}
              })
            })
          })
        }
      }
		})
  },

  calculSalaire(statsRemu, profil) {
    if (this.Remu) {
      this._salaire.set({
        AF: this.Remu.calculSalaireAF(this._bareme, profil),
        TO: this.Remu.calculSalaireTO(this._bareme, profil)
      })
    }
  },

  salaire() {
    return this._salaire.get()
  },

  statsRemu() {
    return this._statsRemu.get()
  },

  isPNT() {
    return isPNT.get()
  },

  loading() {
    return this._isLoading.get()
  },

	setSelectedDay(day) {
    if (day.tag && !day.allday) {
      if (day.tag === 'rotation') {
        day.events = _.map(day.events, evt => this.Remu.findEvent(evt))
        day.etapes = _.filter(day.events, evt => evt.tag === 'vol' || evt.tag === 'mep')
        day.rotation = _.find(day.events, { tag: 'rotation' })
        if (day.rotation) {
          day.svs = _.filter(day.rotation.sv, sv => sv.tsStart.isSame(day.date, 'day') || sv.tsEnd.isSame(day.date, 'day'))
        } else {
          day.svs = {}
        }
      } else {
        const data = this.Remu.findJourSol(day.slug)
        _.extend(day, _.pick(data, 'HcsAF', 'PVAF', 'majoNuitPVAF', 'HcsTO', 'HcsiTO', 'HcsrTO', 'HcSimuInstTO'))
      }
    }
		this.selectedDay.set(day)
    console.log('Controller.setSelectedDay', day)
	},

	resetSelectedDay() {
		this.selectedDay.set(null)
	},

  _reparseEventsOfCurrentMonth(cb) {
    this._stopPlanningCompute = true
  	Meteor.call('getAllEventsOfMonth', this.currentMonth.get(), (error, eventsOfMonth) => {
  		if (eventsOfMonth) {
  			Sync.reparseEvents(eventsOfMonth)
  			if (_.isFunction(cb)) cb(undefined, true)
  		} else if (error) {
  			console.log(error)
  			if (_.isFunction(cb)) cb(error)
  		}
      this._stopPlanningCompute = false
  	})
  },

  askForPlanningReparsing(message, cb) {
		swal({
		  title: 'Erreur de planning',
		  text: message,
		  type: 'warning',
		  showCancelButton: true,
			// buttonsStyling: false,
			// confirmButtonClass: 'btn btn-primary',
			// cancelButtonClass: 'btn btn-danger',
		  confirmButtonColor: '#2800a0',
		  cancelButtonColor: '#ff3268',
		  confirmButtonText: 'Ok',
			cancelButtonText: 'Annuler'
		}).then(() => {
			this.reparseEventsOfCurrentMonth(cb);
		  swal(
		    'Terminé !',
		    'Votre planning a été recalculé.',
		    'success'
		  )
		}, (dismiss) => {
			if (_.isFunction(cb)) cb(dismiss);
		});
	},

  _sortEvents(events) {
		events = _.sortBy(events, 'start')
	},

	prevMonth() {
		this.currentMonth.set(this._prevMonth(this.currentMonth.get()))
	},

	nextMonth() {
		this.currentMonth.set(this._nextMonth(this.currentMonth.get()))
	},

	_prevMonth(date) {
		if (date.month == 0) {
			return {
				month: 11,
				year: date.year - 1
			}
		} else {
			return {
				month: date.month - 1,
				year: date.year
			}
		}
	},

	_nextMonth(date) {
		if (date.month == 11) {
			return {
				month: 0,
				year: parseInt(date.year) + 1
			}
		} else {
			return {
				month: parseInt(date.month) + 1,
				year: date.year
			}
		}
	}
}
