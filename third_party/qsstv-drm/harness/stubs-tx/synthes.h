#ifndef SYNTHES_H
#define SYNTHES_H
#include <QtGlobal>
class synthesizer { public: void writeBuffer(quint32 *buf, int n); };
extern synthesizer *synthesPtr;
#endif
